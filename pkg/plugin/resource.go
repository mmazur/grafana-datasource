package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/mmazur/grafana/pkg/models"
)

// CallResource proxies resource requests to the upstream Grafana.
//
// Routing:
//   - "datasources" → upstream GET /api/datasources (list all datasources)
//   - anything else → upstream /api/datasources/uid/<upstreamDsUid>/resources/<path>
//     This forwards Prometheus metadata APIs (label values, series, etc.) so that
//     Explore's metric browser and autocomplete work transparently.
func (d *Datasource) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	cfg, err := models.LoadPluginSettings(*req.PluginContext.DataSourceInstanceSettings)
	if err != nil {
		return sendErr(sender, http.StatusInternalServerError, fmt.Sprintf("load settings: %v", err))
	}

	upstream := strings.TrimRight(cfg.UpstreamURL, "/")
	if upstream == "" {
		return sendErr(sender, http.StatusBadRequest, "upstreamUrl is not configured")
	}

	authHeader, err := d.buildAuthHeader(ctx, cfg)
	if err != nil {
		return sendErr(sender, http.StatusBadGateway, fmt.Sprintf("auth: %v", err))
	}

	var targetURL string
	if req.Path == "datasources" {
		targetURL = upstream + "/api/datasources"
	} else {
		if cfg.UpstreamDatasourceUID == "" {
			return sendErr(sender, http.StatusBadRequest, "upstreamDatasourceUid is not configured")
		}
		targetURL = upstream + "/api/datasources/uid/" + cfg.UpstreamDatasourceUID + "/resources/" + req.Path
	}

	if req.URL != "" {
		if qIdx := strings.IndexByte(req.URL, '?'); qIdx != -1 {
			targetURL += req.URL[qIdx:]
		}
	}

	method := req.Method
	if method == "" {
		method = http.MethodGet
	}

	resp, err := d.doUpstreamResourceRequest(ctx, cfg, method, targetURL, req.Body, authHeader)
	if err != nil {
		return sendErr(sender, http.StatusBadGateway, fmt.Sprintf("upstream request: %v", err))
	}
	defer closeResponseBody(resp.Body)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return sendErr(sender, http.StatusBadGateway, fmt.Sprintf("read upstream body: %v", err))
	}

	respHeaders := map[string][]string{}
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		respHeaders["Content-Type"] = []string{ct}
	}
	if resp.StatusCode/100 != 2 && len(body) == 0 {
		body = []byte(fmt.Sprintf(`{"message":"upstream returned %d %s"}`, resp.StatusCode, http.StatusText(resp.StatusCode)))
		respHeaders["Content-Type"] = []string{"application/json"}
	}

	return sender.Send(&backend.CallResourceResponse{
		Status:  resp.StatusCode,
		Headers: respHeaders,
		Body:    body,
	})
}

func (d *Datasource) doUpstreamResourceRequest(ctx context.Context, cfg *models.PluginSettings, method string, targetURL string, body []byte, authHeader string) (*http.Response, error) {
	doRequest := func(authHeader string) (*http.Response, error) {
		var bodyReader io.Reader
		if len(body) > 0 {
			bodyReader = strings.NewReader(string(body))
		}

		httpReq, err := http.NewRequestWithContext(ctx, method, targetURL, bodyReader)
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		if authHeader != "" {
			httpReq.Header.Set("Authorization", authHeader)
		}
		if len(body) > 0 {
			httpReq.Header.Set("Content-Type", "application/json")
		}
		return http.DefaultClient.Do(httpReq)
	}

	resp, err := doRequest(authHeader)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusUnauthorized || cfg.AuthMode != "shellcmd" {
		return resp, nil
	}

	if err := resp.Body.Close(); err != nil {
		return nil, fmt.Errorf("close unauthorized response body: %w", err)
	}
	d.clearCachedToken()
	authHeader, err = d.buildAuthHeader(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("auth retry: %w", err)
	}
	return doRequest(authHeader)
}

// buildAuthHeader returns the Authorization header value for the configured auth mode.
// "none" (or empty) -> no header; "bearer" -> static token; "shellcmd" -> token
// minted by running a configured command.
func (d *Datasource) buildAuthHeader(ctx context.Context, cfg *models.PluginSettings) (string, error) {
	switch cfg.AuthMode {
	case "", "none":
		return "", nil
	case "bearer":
		if cfg.Secrets == nil || cfg.Secrets.BearerToken == "" {
			return "", fmt.Errorf("bearer mode selected but no token configured")
		}
		return "Bearer " + cfg.Secrets.BearerToken, nil
	case "shellcmd":
		token, err := d.shellCmdToken(ctx, cfg)
		if err != nil {
			return "", err
		}
		return "Bearer " + token, nil
	default:
		return "", fmt.Errorf("unknown authMode: %q", cfg.AuthMode)
	}
}

// shellCmdToken returns a bearer token for shellcmd auth, reusing a cached token
// while it is younger than TokenTTLSeconds and only re-running the command once
// the cached token has aged out (or when caching is disabled with TTL 0).
func (d *Datasource) shellCmdToken(ctx context.Context, cfg *models.PluginSettings) (string, error) {
	ttl := time.Duration(cfg.TokenTTLSeconds) * time.Second

	d.tokenMu.Lock()
	defer d.tokenMu.Unlock()

	if ttl > 0 && d.cachedToken != "" && time.Since(d.tokenMintedAt) < ttl {
		return d.cachedToken, nil
	}

	token, err := runShellCmdToken(ctx, cfg)
	if err != nil {
		return "", err
	}

	if ttl > 0 {
		d.cachedToken = token
		d.tokenMintedAt = time.Now()
	}
	return token, nil
}

func (d *Datasource) clearCachedToken() {
	d.tokenMu.Lock()
	defer d.tokenMu.Unlock()

	d.cachedToken = ""
	d.tokenMintedAt = time.Time{}
}

// runShellCmdToken runs the configured command to mint a bearer token. The token
// is taken either from a JSON field of stdout (when TokenJSONField is set) or from
// the raw trimmed stdout otherwise.
func runShellCmdToken(ctx context.Context, cfg *models.PluginSettings) (string, error) {
	resolved, err := resolveShellCmd(cfg.ShellCmd)
	if err != nil {
		return "", err
	}

	cmd := exec.CommandContext(ctx, resolved, cfg.ShellArgs...)
	// The plugin subprocess inherits a sanitized env (no HOME/PATH). The command
	// may need HOME for its config dir, so set a minimal env explicitly.
	cmd.Env = shellCmdEnv(resolved)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("shell command failed: %v", err)
	}

	if cfg.TokenJSONField == "" {
		token := strings.TrimSpace(string(out))
		if token == "" {
			return "", fmt.Errorf("shell command returned empty output")
		}
		return token, nil
	}

	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(out, &parsed); err != nil {
		return "", fmt.Errorf("parse shell command output as JSON: %v", err)
	}
	raw, ok := parsed[cfg.TokenJSONField]
	if !ok {
		return "", fmt.Errorf("token field %q not present in shell command output", cfg.TokenJSONField)
	}
	var token string
	if err := json.Unmarshal(raw, &token); err != nil {
		return "", fmt.Errorf("token field %q is not a JSON string: %v", cfg.TokenJSONField, err)
	}
	if token == "" {
		return "", fmt.Errorf("token field %q is empty", cfg.TokenJSONField)
	}
	return token, nil
}

// shellCmdEnv builds a minimal environment for the token command, which may
// require HOME (for its config dir) and PATH. The subprocess env lacks both, so
// we derive HOME from the current user and put the command's own directory on PATH.
func shellCmdEnv(cmdPath string) []string {
	home := ""
	if u, err := user.Current(); err == nil {
		home = u.HomeDir
	}
	path := filepath.Dir(cmdPath) + ":/usr/local/bin:/usr/bin:/bin"
	env := []string{"PATH=" + path}
	if home != "" {
		env = append(env, "HOME="+home)
	}
	return env
}

// resolveShellCmd finds the token command executable. The plugin subprocess runs
// with a sanitized PATH/HOME, so an explicit absolute path from config is
// preferred; otherwise we fall back to PATH lookup.
func resolveShellCmd(shellCmd string) (string, error) {
	if shellCmd == "" {
		return "", fmt.Errorf("shellcmd mode selected but shellCmd is not configured")
	}
	if strings.ContainsRune(shellCmd, os.PathSeparator) {
		if _, err := os.Stat(shellCmd); err != nil {
			return "", fmt.Errorf("configured shellCmd %q not usable: %v", shellCmd, err)
		}
		return shellCmd, nil
	}
	if p, err := exec.LookPath(shellCmd); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("shellCmd %q not found: use an absolute path (subprocess PATH is empty)", shellCmd)
}

func sendErr(sender backend.CallResourceResponseSender, status int, msg string) error {
	return sender.Send(&backend.CallResourceResponse{
		Status: status,
		Body:   []byte(msg),
	})
}

// queryUpstream forwards the given queries to the configured upstream datasource
// via the upstream Grafana's /api/ds/query. Each query's raw JSON is preserved
// (expr, instant/range flags, etc.); only the datasource ref is rewritten to the
// configured upstream UID/type. The columnar JSON response is the data.Frame wire
// format, so the SDK's QueryDataResponse decodes it back into frames directly.
func (d *Datasource) queryUpstream(ctx context.Context, cfg *models.PluginSettings, queries []backend.DataQuery) (*backend.QueryDataResponse, error) {
	upstream := strings.TrimRight(cfg.UpstreamURL, "/")
	if upstream == "" {
		return nil, fmt.Errorf("upstreamUrl is not configured")
	}
	if cfg.UpstreamDatasourceUID == "" {
		return nil, fmt.Errorf("upstreamDatasourceUid is not configured")
	}
	if len(queries) == 0 {
		return backend.NewQueryDataResponse(), nil
	}

	dsRef := map[string]string{"uid": cfg.UpstreamDatasourceUID}
	if cfg.UpstreamDatasourceType != "" {
		dsRef["type"] = cfg.UpstreamDatasourceType
	}
	isPrometheus := cfg.UpstreamDatasourceType == "" || cfg.UpstreamDatasourceType == "prometheus"

	outQueries := make([]map[string]json.RawMessage, 0, len(queries))
	for _, q := range queries {
		m := map[string]json.RawMessage{}
		if len(q.JSON) > 0 {
			if err := json.Unmarshal(q.JSON, &m); err != nil {
				return nil, fmt.Errorf("unmarshal query %q: %w", q.RefID, err)
			}
		}
		// Rewrite the datasource ref to the upstream and keep the SDK-parsed
		// fields authoritative so the forwarded query matches what Grafana sent us.
		setRaw(m, "datasource", dsRef)
		setRaw(m, "refId", q.RefID)
		if _, hasIntervalMs := m["intervalMs"]; !hasIntervalMs {
			setRaw(m, "intervalMs", q.Interval.Milliseconds())
		}
		if _, hasMaxDataPoints := m["maxDataPoints"]; !hasMaxDataPoints {
			setRaw(m, "maxDataPoints", q.MaxDataPoints)
		}
		// Prometheus upstream defaults to instant when neither flag is present;
		// default to range so a bare {expr} query produces a time series.
		if isPrometheus {
			if _, hasRange := m["range"]; !hasRange {
				if _, hasInstant := m["instant"]; !hasInstant {
					setRaw(m, "range", true)
					setRaw(m, "instant", false)
				}
			}
		}
		outQueries = append(outQueries, m)
	}

	tr := queries[0].TimeRange
	body, err := json.Marshal(map[string]any{
		"queries": outQueries,
		"from":    fmt.Sprintf("%d", tr.From.UnixMilli()),
		"to":      fmt.Sprintf("%d", tr.To.UnixMilli()),
	})
	if err != nil {
		return nil, fmt.Errorf("marshal upstream body: %w", err)
	}

	authHeader, err := d.buildAuthHeader(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}

	logger := log.DefaultLogger
	logger.Debug("Upstream query request", "url", upstream+"/api/ds/query", "bodyLen", len(body))

	start := time.Now()
	resp, err := d.doUpstreamQueryRequest(ctx, cfg, upstream+"/api/ds/query", body, authHeader)
	elapsed := time.Since(start)
	if err != nil {
		logger.Error("Upstream request failed", "url", upstream+"/api/ds/query", "elapsed", elapsed, "error", err)
		return nil, fmt.Errorf("upstream request: %w", err)
	}
	defer closeResponseBody(resp.Body)

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read upstream body: %w", err)
	}

	if resp.StatusCode/100 != 2 {
		// The upstream may return 4xx/5xx with a valid QueryDataResponse body
		// containing per-query errors (e.g. PromQL syntax errors return 400).
		// Try to parse it as a normal response first.
		var qdr backend.QueryDataResponse
		if err := json.Unmarshal(respBody, &qdr); err == nil && len(qdr.Responses) > 0 {
			return &qdr, nil
		}
		// Opaque error (e.g. gateway HTML page). Return as per-query errors
		// so the message surfaces in the UI instead of the generic plugin error.
		errMsg := extractUpstreamError(respBody, resp.StatusCode)
		logger.Error("Upstream returned error", "url", upstream+"/api/ds/query", "status", resp.StatusCode, "elapsed", elapsed, "error", errMsg)
		response := backend.NewQueryDataResponse()
		for _, q := range queries {
			response.Responses[q.RefID] = backend.ErrDataResponse(backend.Status(resp.StatusCode), errMsg)
		}
		return response, nil
	}

	var qdr backend.QueryDataResponse
	if err := json.Unmarshal(respBody, &qdr); err != nil {
		logger.Error("Failed to decode upstream response", "error", err, "body", truncate(respBody, 512))
		return nil, fmt.Errorf("decode upstream response: %w", err)
	}
	if qdr.Responses == nil {
		qdr.Responses = backend.Responses{}
	}
	for refID, dr := range qdr.Responses {
		if dr.Error != nil {
			logger.Debug("Upstream query error", "refId", refID, "error", dr.Error, "status", dr.Status)
		}
	}
	return &qdr, nil
}

func (d *Datasource) doUpstreamQueryRequest(ctx context.Context, cfg *models.PluginSettings, targetURL string, body []byte, authHeader string) (*http.Response, error) {
	doRequest := func(authHeader string) (*http.Response, error) {
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, strings.NewReader(string(body)))
		if err != nil {
			return nil, fmt.Errorf("build upstream request: %w", err)
		}
		httpReq.Header.Set("Content-Type", "application/json")
		if authHeader != "" {
			httpReq.Header.Set("Authorization", authHeader)
		}
		return http.DefaultClient.Do(httpReq)
	}

	resp, err := doRequest(authHeader)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusUnauthorized || cfg.AuthMode != "shellcmd" {
		return resp, nil
	}

	if err := resp.Body.Close(); err != nil {
		return nil, fmt.Errorf("close unauthorized response body: %w", err)
	}
	d.clearCachedToken()
	authHeader, err = d.buildAuthHeader(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("auth retry: %w", err)
	}
	return doRequest(authHeader)
}

// setRaw marshals v and stores it under key, dropping the key on marshal error.
func setRaw(m map[string]json.RawMessage, key string, v any) {
	if raw, err := json.Marshal(v); err == nil {
		m[key] = raw
	}
}

func closeResponseBody(body io.Closer) {
	if err := body.Close(); err != nil {
		log.DefaultLogger.Warn("Failed to close upstream response body", "error", err)
	}
}

// extractUpstreamError attempts to produce a human-readable error from an
// upstream error response. It handles JSON error bodies (Grafana/Prometheus
// style) and falls back to reporting the HTTP status for HTML/opaque responses.
func extractUpstreamError(body []byte, statusCode int) string {
	// Try JSON: Grafana returns {"message":"..."} or {"error":"..."}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err == nil {
		if msg, ok := obj["message"].(string); ok && msg != "" {
			return fmt.Sprintf("upstream error %d: %s", statusCode, msg)
		}
		if msg, ok := obj["error"].(string); ok && msg != "" {
			return fmt.Sprintf("upstream error %d: %s", statusCode, msg)
		}
	}

	// HTML response (e.g. Azure gateway error page) — don't dump markup.
	if len(body) > 0 && (body[0] == '<' || strings.Contains(string(body[:min(len(body), 100)]), "<html") || strings.Contains(string(body[:min(len(body), 100)]), "<body")) {
		return fmt.Sprintf("upstream returned HTTP %d (gateway error)", statusCode)
	}

	// Fallback: truncated raw body.
	return fmt.Sprintf("upstream returned HTTP %d: %s", statusCode, truncate(body, 200))
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
