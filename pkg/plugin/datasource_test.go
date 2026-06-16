package plugin

import (
	"context"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestQueryDataWithoutInstanceSettings(t *testing.T) {
	ds := Datasource{}

	_, err := ds.QueryData(
		context.Background(),
		&backend.QueryDataRequest{
			Queries: []backend.DataQuery{
				{RefID: "A"},
			},
		},
	)
	if err == nil {
		t.Fatal("expected QueryData to return an error")
	}
	if !strings.Contains(err.Error(), "datasource instance settings are unavailable") {
		t.Fatalf("unexpected error: %v", err)
	}
}
