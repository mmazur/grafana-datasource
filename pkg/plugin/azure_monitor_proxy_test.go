package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/mmazur/grafana/pkg/models"
)

func TestQueryAzureMonitorViaProxyBuildsResourceRequestAndFrames(t *testing.T) {
	from := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	to := from.Add(30 * time.Minute)

	var requestedPath string
	var requestedQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		requestedQuery = r.URL.RawQuery

		if r.Method != http.MethodGet {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		if r.Header.Get("Authorization") != "" {
			t.Fatalf("unexpected auth header: %s", r.Header.Get("Authorization"))
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"value": [{
				"name": {"value": "Percentage CPU", "localizedValue": "Percentage CPU"},
				"unit": "Percent",
				"timeseries": [{
					"metadatavalues": [{"name": {"value": "vm"}, "value": "vm1"}],
					"data": [
						{"timeStamp": "2026-07-01T10:00:00Z", "average": 1.5},
						{"timeStamp": "2026-07-01T10:30:00Z", "average": 2.5}
					]
				}]
			}]
		}`))
	}))
	defer server.Close()

	queryJSON := mustMarshal(t, map[string]any{
		"subscription": "sub1",
		"azureMonitor": map[string]any{
			"resources": []map[string]any{{
				"subscription":    "sub1",
				"resourceGroup":   "rg1",
				"metricNamespace": "Microsoft.Compute/virtualMachines",
				"resourceName":    "vm1",
			}},
			"metricNamespace": "Microsoft.Compute/virtualMachines",
			"metricName":      "Percentage CPU",
			"aggregation":     "Average",
			"timeGrain":       "PT30M",
		},
	})

	ds := Datasource{}
	resp, err := ds.queryAzureMonitorViaProxy(context.Background(), &models.PluginSettings{
		UpstreamURL:           server.URL,
		UpstreamDatasourceUID: "azure-monitor-oob",
		AuthMode:              "none",
	}, []backend.DataQuery{{
		RefID:     "A",
		Interval:  30 * time.Minute,
		TimeRange: backend.TimeRange{From: from, To: to},
		JSON:      queryJSON,
	}})
	if err != nil {
		t.Fatalf("queryAzureMonitorViaProxy returned error: %v", err)
	}

	wantPath := "/api/datasources/uid/azure-monitor-oob/resources/azuremonitor/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1/providers/microsoft.insights/metrics"
	if requestedPath != wantPath {
		t.Fatalf("unexpected path:\nwant %s\n got %s", wantPath, requestedPath)
	}
	for _, fragment := range []string{
		"api-version=2018-01-01",
		"aggregation=Average",
		"interval=PT30M",
		"metricnames=Percentage+CPU",
		"metricnamespace=Microsoft.Compute%2FvirtualMachines",
		"timespan=2026-07-01T10%3A00%3A00Z%2F2026-07-01T10%3A30%3A00Z",
	} {
		if !strings.Contains(requestedQuery, fragment) {
			t.Fatalf("expected query to contain %q, got %q", fragment, requestedQuery)
		}
	}

	dataResponse := resp.Responses["A"]
	if dataResponse.Error != nil {
		t.Fatalf("unexpected data response error: %v", dataResponse.Error)
	}
	if len(dataResponse.Frames) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(dataResponse.Frames))
	}
	frame := dataResponse.Frames[0]
	if frame.RefID != "A" {
		t.Fatalf("unexpected frame ref ID: %s", frame.RefID)
	}
	if frame.Fields[1].Name != "Percentage CPU" {
		t.Fatalf("unexpected value field name: %s", frame.Fields[1].Name)
	}
	if frame.Fields[1].Config == nil || frame.Fields[1].Config.Unit != "percent" {
		t.Fatalf("unexpected value field unit: %#v", frame.Fields[1].Config)
	}
	if frame.Fields[1].Len() != 2 {
		t.Fatalf("expected 2 values, got %d", frame.Fields[1].Len())
	}
}

func mustMarshal(t *testing.T, value any) json.RawMessage {
	t.Helper()

	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
