import { DataSourceInstanceSettings, CoreApp, ScopedVars, type MetricFindValue } from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv } from '@grafana/runtime';
import { CodeEditorSuggestionItemKind, type CodeEditorSuggestionItem, type ComboboxOption } from '@grafana/ui';

import { MyQuery, MyDataSourceOptions, DEFAULT_QUERY } from './types';

const MAX_METRIC_PICKER_OPTIONS = 200;
const AZURE_MONITOR_TYPE = 'grafana-azure-monitor-datasource';
const AZURE_MONITOR_PROXY_TYPE = 'grafana-azure-monitor-datasource-proxy';
const PROMETHEUS_TYPE = 'prometheus';
const PLUGIN_DATASOURCE_TYPE = 'mmazur-grafana-datasource';
const DEFAULT_AZURE_TIME_GRAIN = 'PT30M';
const DEFAULT_MAX_DATA_POINTS = 1000;
const LABEL_VALUES_QUERY = /^\s*label_values\((?:(.*)\s*,\s*)?([A-Za-z_][A-Za-z0-9_]*)\)\s*$/;

export interface AzureMonitorSubscription {
  displayName?: string;
  name?: string;
  subscriptionId?: string;
  state?: string;
}

export interface AzureMonitorResourceGroup {
  id?: string;
  name?: string;
  location?: string;
}

export interface AzureMonitorResourceItem {
  id: string;
  name: string;
  type: string;
  resourceGroup: string;
  location?: string;
}

export interface AzureMonitorMetricDefinition {
  name?: {
    value?: string;
    localizedValue?: string;
  };
  primaryAggregationType?: string;
  supportedAggregationTypes?: string[];
  unit?: string;
  metricAvailabilities?: Array<{
    timeGrain?: string;
  }>;
}

export class DataSource extends DataSourceWithBackend<MyQuery, MyDataSourceOptions> {
  private metricNamesCache: string[] | null = null;
  private instanceName: string;
  private instanceUid: string;
  private upstreamDatasourceUid?: string;
  private upstreamDatasourceType?: string;

  constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>) {
    super(instanceSettings);
    this.instanceName = instanceSettings.name;
    this.instanceUid = instanceSettings.uid;
    this.upstreamDatasourceUid = instanceSettings.jsonData.upstreamDatasourceUid;
    this.upstreamDatasourceType = instanceSettings.jsonData.upstreamDatasourceType;
  }

  getUpstreamDatasourceUid(): string | undefined {
    return this.upstreamDatasourceUid;
  }

  getUpstreamDatasourceType(): string | undefined {
    return this.upstreamDatasourceType;
  }

  getQueryUpstreamDatasourceType(): string {
    return this.isAzureMonitor() ? AZURE_MONITOR_TYPE : PROMETHEUS_TYPE;
  }

  getDatasourceRef() {
    return {
      type: PLUGIN_DATASOURCE_TYPE,
      uid: this.instanceUid,
    };
  }

  isAzureMonitor(): boolean {
    return (
      this.upstreamDatasourceType === AZURE_MONITOR_TYPE ||
      this.upstreamDatasourceType === AZURE_MONITOR_PROXY_TYPE ||
      this.upstreamDatasourceUid === 'azure-monitor-oob' ||
      this.instanceName.endsWith('-azure-monitor')
    );
  }

  isPrometheus(): boolean {
    return !this.isAzureMonitor() && (!this.upstreamDatasourceType || this.upstreamDatasourceType === PROMETHEUS_TYPE);
  }

  async getMetricNames(): Promise<string[]> {
    if (!this.isPrometheus()) {
      return [];
    }

    if (this.metricNamesCache) {
      return this.metricNamesCache;
    }
    try {
      const resp = await this.getResource('api/v1/label/__name__/values');
      this.metricNamesCache = resp?.data ?? [];
      return this.metricNamesCache!;
    } catch {
      return [];
    }
  }

  async getMetricOptions(search = ''): Promise<Array<ComboboxOption<string>>> {
    const needle = search.trim().toLowerCase();
    const metrics = await this.getMetricNames();

    return metrics
      .filter((name) => needle === '' || name.toLowerCase().includes(needle))
      .slice(0, MAX_METRIC_PICKER_OPTIONS)
      .map((name) => ({ label: name, value: name }));
  }

  async metricFindQuery(query: string | { query?: string }): Promise<MetricFindValue[]> {
    if (!this.isPrometheus()) {
      return [];
    }

    const queryText = typeof query === 'string' ? query : query.query ?? '';
    const match = queryText.match(LABEL_VALUES_QUERY);
    if (!match) {
      return [];
    }

    const metric = match[1]?.trim();
    const label = match[2];
    if (!metric) {
      const resp = await this.getResource(`api/v1/label/${encodeURIComponent(label)}/values`);
      return (resp?.data ?? []).map((value: string) => ({ text: value, value }));
    }

    const params = new URLSearchParams();
    params.set('match[]', metric);
    const resp = await this.getResource(`api/v1/series?${params.toString()}`);
    const values = new Set<string>();
    for (const series of resp?.data ?? []) {
      const value = series?.[label];
      if (typeof value === 'string' && value !== '') {
        values.add(value);
      }
    }

    return [...values].sort().map((value) => ({ text: value, value }));
  }

  getMetricSuggestions(): CodeEditorSuggestionItem[] {
    return (this.metricNamesCache ?? []).map((name) => ({
      label: name,
      kind: CodeEditorSuggestionItemKind.Field,
      insertText: name,
    }));
  }

  async getAzureMonitorSubscriptions(): Promise<AzureMonitorSubscription[]> {
    const resp = await this.getResource('azuremonitor/subscriptions?api-version=2019-03-01');
    return resp?.value ?? [];
  }

  async getAzureMonitorResourceGroups(subscription: string): Promise<AzureMonitorResourceGroup[]> {
    if (!subscription) {
      return [];
    }

    const resp = await this.getResource(
      `azuremonitor/subscriptions/${subscription}/resourcegroups?api-version=2021-04-01`
    );
    return resp?.value ?? [];
  }

  async getAzureMonitorResources(subscription: string, resourceGroup: string): Promise<AzureMonitorResourceItem[]> {
    if (!subscription || !resourceGroup) {
      return [];
    }

    const resp = await this.postResource<{ data?: AzureMonitorResourceItem[] }>(
      'resourcegraph/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01',
      {
        query: `resources
| where subscriptionId == '${subscription}'
| where resourceGroup =~ '${resourceGroup}'
| project id, name, type, resourceGroup, location
| order by tolower(name) asc
| limit 500`,
        options: {
          resultFormat: 'objectArray',
        },
      }
    );
    return resp?.data ?? [];
  }

  async getAzureMonitorMetricDefinitions(resourceUri: string): Promise<AzureMonitorMetricDefinition[]> {
    const normalizedResourceUri = resourceUri.startsWith('/') ? resourceUri : `/${resourceUri}`;
    const resp = await this.getResource(
      `azuremonitor${normalizedResourceUri}/providers/microsoft.insights/metricdefinitions?api-version=2018-01-01`
    );
    return resp?.value ?? [];
  }

  getDefaultQuery(_: CoreApp): Partial<MyQuery> {
    if (this.isAzureMonitor()) {
      return {
        queryType: 'Azure Monitor',
        upstreamDatasourceType: this.getQueryUpstreamDatasourceType(),
        datasource: this.getDatasourceRef(),
        subscription: '',
        azureMonitor: {
          resources: [
            {
              subscription: '',
              resourceGroup: '',
              metricNamespace: '',
              resourceName: '',
            },
          ],
          metricNamespace: '',
          metricName: '',
          aggregation: '',
          timeGrain: DEFAULT_AZURE_TIME_GRAIN,
          dimensionFilters: [],
        },
        intervalMs: DEFAULT_AZURE_TIME_GRAIN === 'PT30M' ? 30 * 60 * 1000 : undefined,
        maxDataPoints: DEFAULT_MAX_DATA_POINTS,
      };
    }

    return {
      ...DEFAULT_QUERY,
      upstreamDatasourceType: this.getQueryUpstreamDatasourceType(),
      datasource: this.getDatasourceRef(),
    };
  }

  applyTemplateVariables(query: MyQuery, scopedVars: ScopedVars) {
    return {
      ...query,
      expr: getTemplateSrv().replace(query.expr, scopedVars),
    };
  }

  filterQuery(query: MyQuery): boolean {
    if (this.isAzureMonitor()) {
      const azureMonitor = query.azureMonitor;
      const resource = azureMonitor?.resources?.[0];
      return !!(
        query.subscription &&
        resource?.resourceGroup &&
        resource?.resourceName &&
        resource?.metricNamespace &&
        azureMonitor?.metricNamespace &&
        azureMonitor?.metricName &&
        azureMonitor?.aggregation
      );
    }

    // Skip Prometheus execution until an expression has been entered.
    return !!query.expr;
  }
}
