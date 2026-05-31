package models

import (
	"encoding/json"
	"fmt"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

type PluginSettings struct {
	// UpstreamURL is the base URL of the Grafana instance we proxy to,
	// e.g. https://example.grafana.azure.com
	UpstreamURL string `json:"upstreamUrl"`
	// UpstreamDatasourceUID pins this plugin instance to a single upstream
	// datasource; queries are forwarded to it via the upstream /api/ds/query.
	UpstreamDatasourceUID string `json:"upstreamDatasourceUid"`
	// UpstreamDatasourceType is the upstream datasource type (e.g. "prometheus"),
	// sent in the forwarded query's datasource ref.
	UpstreamDatasourceType string `json:"upstreamDatasourceType"`
	// AuthMode selects how we authenticate to the upstream: "none", "bearer", or "shellcmd".
	AuthMode string `json:"authMode"`
	// ShellCmd is the executable run in "shellcmd" mode to mint a bearer token.
	// The plugin subprocess runs with a sanitized PATH/HOME, so an absolute path
	// is needed unless the command happens to be resolvable on PATH.
	ShellCmd string `json:"shellCmd"`
	// ShellArgs are the arguments passed to ShellCmd.
	ShellArgs []string `json:"shellArgs"`
	// TokenJSONField, when set, parses ShellCmd's stdout as JSON and extracts the
	// token from this top-level field. When empty, the raw (trimmed) stdout is used.
	TokenJSONField string `json:"tokenJsonField"`
	// TokenTTLSeconds is how long a minted token is cached and reused before the
	// command is run again. 0 disables caching (command runs on every request).
	TokenTTLSeconds int `json:"tokenTtlSeconds"`

	Secrets *SecretPluginSettings `json:"-"`
}

type SecretPluginSettings struct {
	// BearerToken is the static token used in "bearer" mode.
	BearerToken string `json:"bearerToken"`
}

func LoadPluginSettings(source backend.DataSourceInstanceSettings) (*PluginSettings, error) {
	settings := PluginSettings{}
	err := json.Unmarshal(source.JSONData, &settings)
	if err != nil {
		return nil, fmt.Errorf("could not unmarshal PluginSettings json: %w", err)
	}

	settings.Secrets = loadSecretPluginSettings(source.DecryptedSecureJSONData)

	return &settings, nil
}

func loadSecretPluginSettings(source map[string]string) *SecretPluginSettings {
	return &SecretPluginSettings{
		BearerToken: source["bearerToken"],
	}
}
