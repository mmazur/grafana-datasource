import { DataSourceJsonData } from '@grafana/data';
import { DataQuery } from '@grafana/schema';

export interface MyQuery extends DataQuery {
  // Marker used to detect stale Explore URL state when switching between
  // upstream datasource families.
  upstreamDatasourceType?: string;
  // PromQL (or upstream-native) expression, forwarded to the upstream datasource.
  expr?: string;
  // Return an instant vector (single point at the end of the range) instead of
  // a range series. `range` is kept as the inverse for the upstream Prometheus API.
  instant?: boolean;
  range?: boolean;
  queryType?: 'Azure Monitor';
  subscription?: string;
  azureMonitor?: AzureMetricQuery;
  intervalMs?: number;
  maxDataPoints?: number;
}

export interface AzureMetricQuery {
  resources?: AzureMonitorResource[];
  metricNamespace?: string;
  metricName?: string;
  aggregation?: string;
  timeGrain?: string;
  allowedTimeGrainsMs?: number[];
  dimensionFilters?: AzureMetricDimension[];
}

export interface AzureMonitorResource {
  subscription?: string;
  resourceGroup?: string;
  metricNamespace?: string;
  resourceName?: string;
}

export interface AzureMetricDimension {
  dimension?: string;
  operator?: string;
  filters?: string[];
}

export const DEFAULT_QUERY: Partial<MyQuery> = {
  upstreamDatasourceType: 'prometheus',
  expr: '',
  instant: false,
  range: true,
};

export type AuthMode = 'none' | 'bearer' | 'shellcmd';

/**
 * These are options configured for each DataSource instance
 */
export interface MyDataSourceOptions extends DataSourceJsonData {
  // Base URL of the upstream Grafana we proxy to.
  upstreamUrl?: string;
  // UID of the single upstream datasource this instance forwards queries to.
  upstreamDatasourceUid?: string;
  // Type of the upstream datasource (e.g. "prometheus"). Use
  // "grafana-azure-monitor-datasource-proxy" to execute Azure Monitor metrics
  // through the upstream resource API instead of /api/ds/query.
  upstreamDatasourceType?: string;
  // How we authenticate to the upstream.
  authMode?: AuthMode;
  // Command run in "shellcmd" mode to mint a bearer token (absolute path
  // recommended — the backend subprocess runs with an empty PATH).
  shellCmd?: string;
  // Arguments passed to shellCmd.
  shellArgs?: string[];
  // When set, shellCmd stdout is parsed as JSON and the token read from this
  // top-level field; when empty, raw trimmed stdout is used.
  tokenJsonField?: string;
  // How long (seconds) a minted token is cached and reused before the command
  // is run again. 0 disables caching.
  tokenTtlSeconds?: number;
}

/**
 * Value that is used in the backend, but never sent over HTTP to the frontend
 */
export interface MySecureJsonData {
  // Static token used in "bearer" mode.
  bearerToken?: string;
}
