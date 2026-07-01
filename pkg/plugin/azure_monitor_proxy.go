package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/mmazur/grafana/pkg/models"
)

const azureMonitorDatasourceType = "grafana-azure-monitor-datasource"

type azureMonitorProxyQuery struct {
	Subscription string                  `json:"subscription"`
	AzureMonitor azureMonitorMetricQuery `json:"azureMonitor"`
}

type azureMonitorMetricQuery struct {
	Resources        []azureMonitorResource        `json:"resources"`
	MetricNamespace  string                        `json:"metricNamespace"`
	MetricName       string                        `json:"metricName"`
	Aggregation      string                        `json:"aggregation"`
	TimeGrain        string                        `json:"timeGrain"`
	DimensionFilters []azureMonitorDimensionFilter `json:"dimensionFilters"`
}

type azureMonitorResource struct {
	Subscription    string `json:"subscription"`
	ResourceGroup   string `json:"resourceGroup"`
	MetricNamespace string `json:"metricNamespace"`
	ResourceName    string `json:"resourceName"`
}

type azureMonitorDimensionFilter struct {
	Dimension string   `json:"dimension"`
	Operator  string   `json:"operator"`
	Filters   []string `json:"filters"`
}

type azureMonitorMetricsResponse struct {
	Value []azureMonitorMetricValue `json:"value"`
	Error *azureMonitorAPIError     `json:"error"`
}

type azureMonitorAPIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type azureMonitorMetricValue struct {
	Name       azureMonitorLocalizedValue `json:"name"`
	Unit       string                     `json:"unit"`
	TimeSeries []azureMonitorTimeSeries   `json:"timeseries"`
}

type azureMonitorLocalizedValue struct {
	Value          string `json:"value"`
	LocalizedValue string `json:"localizedValue"`
}

type azureMonitorTimeSeries struct {
	MetadataValues []azureMonitorMetadataValue `json:"metadatavalues"`
	Data           []azureMonitorPoint         `json:"data"`
}

type azureMonitorMetadataValue struct {
	Name  azureMonitorLocalizedValue `json:"name"`
	Value string                     `json:"value"`
}

type azureMonitorPoint struct {
	TimeStamp time.Time `json:"timeStamp"`
	Average   *float64  `json:"average"`
	Minimum   *float64  `json:"minimum"`
	Maximum   *float64  `json:"maximum"`
	Total     *float64  `json:"total"`
	Count     *float64  `json:"count"`
}

func (d *Datasource) queryAzureMonitorViaProxy(ctx context.Context, cfg *models.PluginSettings, queries []backend.DataQuery) (*backend.QueryDataResponse, error) {
	upstream := strings.TrimRight(cfg.UpstreamURL, "/")
	if upstream == "" {
		return nil, fmt.Errorf("upstreamUrl is not configured")
	}
	if cfg.UpstreamDatasourceUID == "" {
		return nil, fmt.Errorf("upstreamDatasourceUid is not configured")
	}

	response := backend.NewQueryDataResponse()
	for _, q := range queries {
		frames, err := d.querySingleAzureMonitorViaProxy(ctx, cfg, upstream, q)
		if err != nil {
			response.Responses[q.RefID] = backend.ErrDataResponse(backend.StatusBadGateway, err.Error())
			continue
		}
		response.Responses[q.RefID] = backend.DataResponse{
			Status: backend.StatusOK,
			Frames: frames,
		}
	}
	return response, nil
}

func (d *Datasource) querySingleAzureMonitorViaProxy(ctx context.Context, cfg *models.PluginSettings, upstream string, q backend.DataQuery) (data.Frames, error) {
	var query azureMonitorProxyQuery
	if len(q.JSON) > 0 {
		if err := json.Unmarshal(q.JSON, &query); err != nil {
			return nil, fmt.Errorf("unmarshal Azure Monitor query %q: %w", q.RefID, err)
		}
	}

	resource, err := selectAzureMonitorResource(query)
	if err != nil {
		return nil, err
	}

	metricNamespace := firstNonEmpty(query.AzureMonitor.MetricNamespace, resource.MetricNamespace)
	metricName := query.AzureMonitor.MetricName
	aggregation := query.AzureMonitor.Aggregation
	if metricNamespace == "" || metricName == "" || aggregation == "" {
		return nil, fmt.Errorf("Azure Monitor query %q is missing metric namespace, metric name, or aggregation", q.RefID)
	}

	resourcePath, err := buildAzureMonitorResourcePath(resource, firstNonEmpty(query.Subscription, resource.Subscription), metricNamespace)
	if err != nil {
		return nil, err
	}

	params := url.Values{}
	params.Set("api-version", "2018-01-01")
	params.Set("metricnames", metricName)
	params.Set("aggregation", aggregation)
	params.Set("interval", azureMonitorInterval(query.AzureMonitor.TimeGrain, q.Interval))
	params.Set("timespan", q.TimeRange.From.UTC().Format(time.RFC3339)+"/"+q.TimeRange.To.UTC().Format(time.RFC3339))
	params.Set("metricnamespace", metricNamespace)
	if filter := azureMonitorFilter(query.AzureMonitor.DimensionFilters); filter != "" {
		params.Set("$filter", filter)
	}

	targetURL := upstream + "/api/datasources/uid/" + cfg.UpstreamDatasourceUID + "/resources/azuremonitor" + resourcePath + "/providers/microsoft.insights/metrics?" + params.Encode()
	authHeader, err := d.buildAuthHeader(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}

	resp, err := d.doUpstreamResourceRequest(ctx, cfg, http.MethodGet, targetURL, nil, authHeader)
	if err != nil {
		return nil, fmt.Errorf("upstream request: %w", err)
	}
	defer closeResponseBody(resp.Body)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read upstream body: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("%s", extractUpstreamError(body, resp.StatusCode))
	}

	var metrics azureMonitorMetricsResponse
	if err := json.Unmarshal(body, &metrics); err != nil {
		return nil, fmt.Errorf("decode Azure Monitor metrics response: %w", err)
	}
	if metrics.Error != nil {
		return nil, fmt.Errorf("Azure Monitor error %s: %s", metrics.Error.Code, metrics.Error.Message)
	}

	return azureMonitorMetricsToFrames(q.RefID, metrics, aggregation, metricNamespace, resource), nil
}

func selectAzureMonitorResource(query azureMonitorProxyQuery) (azureMonitorResource, error) {
	for _, resource := range query.AzureMonitor.Resources {
		if resource.Subscription != "" || resource.ResourceGroup != "" || resource.ResourceName != "" || resource.MetricNamespace != "" {
			return resource, nil
		}
	}
	return azureMonitorResource{}, fmt.Errorf("Azure Monitor query has no resource")
}

func buildAzureMonitorResourcePath(resource azureMonitorResource, subscription string, metricNamespace string) (string, error) {
	if subscription == "" || resource.ResourceGroup == "" || resource.ResourceName == "" || metricNamespace == "" {
		return "", fmt.Errorf("Azure Monitor query resource is missing subscription, resource group, resource name, or metric namespace")
	}

	namespaceParts := strings.Split(metricNamespace, "/")
	nameParts := strings.Split(resource.ResourceName, "/")
	if len(namespaceParts) < 2 {
		return "", fmt.Errorf("invalid Azure Monitor metric namespace %q", metricNamespace)
	}
	if len(nameParts) == 0 || nameParts[0] == "" {
		return "", fmt.Errorf("invalid Azure Monitor resource name %q", resource.ResourceName)
	}

	parts := []string{"", "subscriptions", subscription, "resourceGroups", resource.ResourceGroup, "providers", namespaceParts[0]}
	remainingTypes := namespaceParts[1:]
	if len(nameParts) > len(remainingTypes) {
		parts = append(parts, nameParts[0])
		nameParts = nameParts[1:]
	}
	if len(nameParts) != len(remainingTypes) {
		return "", fmt.Errorf("resource name %q does not match metric namespace %q", resource.ResourceName, metricNamespace)
	}
	for i, typ := range remainingTypes {
		parts = append(parts, typ, nameParts[i])
	}

	escaped := make([]string, 0, len(parts))
	for _, part := range parts {
		escaped = append(escaped, url.PathEscape(part))
	}
	return strings.Join(escaped, "/"), nil
}

func azureMonitorInterval(timeGrain string, interval time.Duration) string {
	if timeGrain != "" && !strings.EqualFold(timeGrain, "auto") {
		return strings.ToUpper(timeGrain)
	}
	if interval <= 0 {
		return "PT30M"
	}
	return durationToISO8601(interval)
}

func durationToISO8601(d time.Duration) string {
	seconds := int64(d.Round(time.Second) / time.Second)
	if seconds <= 0 {
		return "PT30M"
	}
	hours := seconds / 3600
	seconds %= 3600
	minutes := seconds / 60
	seconds %= 60

	var b strings.Builder
	b.WriteString("PT")
	if hours > 0 {
		b.WriteString(strconv.FormatInt(hours, 10))
		b.WriteByte('H')
	}
	if minutes > 0 {
		b.WriteString(strconv.FormatInt(minutes, 10))
		b.WriteByte('M')
	}
	if seconds > 0 || (hours == 0 && minutes == 0) {
		b.WriteString(strconv.FormatInt(seconds, 10))
		b.WriteByte('S')
	}
	return b.String()
}

func azureMonitorFilter(filters []azureMonitorDimensionFilter) string {
	clauses := make([]string, 0, len(filters))
	for _, filter := range filters {
		if filter.Dimension == "" || len(filter.Filters) == 0 {
			continue
		}
		operator := filter.Operator
		if operator == "" {
			operator = "eq"
		}
		values := make([]string, 0, len(filter.Filters))
		for _, value := range filter.Filters {
			if value == "" {
				continue
			}
			values = append(values, "'"+strings.ReplaceAll(value, "'", "''")+"'")
		}
		if len(values) == 0 {
			continue
		}
		clauses = append(clauses, filter.Dimension+" "+operator+" "+strings.Join(values, " or "+filter.Dimension+" "+operator+" "))
	}
	return strings.Join(clauses, " and ")
}

func azureMonitorMetricsToFrames(refID string, metrics azureMonitorMetricsResponse, aggregation string, metricNamespace string, resource azureMonitorResource) data.Frames {
	frames := data.Frames{}
	valueKey := strings.ToLower(aggregation)
	for _, metric := range metrics.Value {
		metricName := firstNonEmpty(metric.Name.LocalizedValue, metric.Name.Value)
		if metricName == "" {
			metricName = aggregation
		}
		for i, series := range metric.TimeSeries {
			times := make([]time.Time, 0, len(series.Data))
			values := make([]*float64, 0, len(series.Data))
			for _, point := range series.Data {
				value := azureMonitorPointValue(point, valueKey)
				times = append(times, point.TimeStamp)
				values = append(values, value)
			}

			labels := data.Labels{
				"resourceGroup": resource.ResourceGroup,
				"resourceName":  resource.ResourceName,
				"namespace":     metricNamespace,
				"aggregation":   aggregation,
			}
			for _, metadata := range series.MetadataValues {
				if metadata.Name.Value != "" && metadata.Value != "" {
					labels[metadata.Name.Value] = metadata.Value
				}
			}

			valueField := data.NewField(metricName, labels, values)
			if metric.Unit != "" {
				valueField.Config = &data.FieldConfig{Unit: azureMonitorUnit(metric.Unit)}
			}
			frameName := metricName
			if len(metric.TimeSeries) > 1 {
				frameName = fmt.Sprintf("%s %d", metricName, i+1)
			}
			frame := data.NewFrame(frameName, data.NewField("Time", nil, times), valueField)
			frame.RefID = refID
			frames = append(frames, frame)
		}
	}
	if len(frames) == 0 {
		frame := data.NewFrame(refID, data.NewField("Time", nil, []time.Time{}), data.NewField(aggregation, nil, []*float64{}))
		frame.RefID = refID
		frames = append(frames, frame)
	}
	return frames
}

func azureMonitorPointValue(point azureMonitorPoint, aggregation string) *float64 {
	switch aggregation {
	case "average":
		return point.Average
	case "minimum":
		return point.Minimum
	case "maximum":
		return point.Maximum
	case "total":
		return point.Total
	case "count":
		return point.Count
	default:
		return point.Average
	}
}

func azureMonitorUnit(unit string) string {
	switch strings.ToLower(unit) {
	case "percent":
		return "percent"
	case "bytes":
		return "bytes"
	case "seconds":
		return "s"
	case "milliseconds":
		return "ms"
	default:
		return unit
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
