import React from 'react';
import {
  Button,
  CodeEditor,
  Combobox,
  InlineField,
  Input,
  RadioButtonGroup,
  Select,
  Stack,
  type ComboboxOption,
  type Monaco,
  type MonacoEditor,
} from '@grafana/ui';
import { CoreApp, QueryEditorProps, SelectableValue } from '@grafana/data';
import { DataSource } from '../datasource';
import { MyDataSourceOptions, MyQuery } from '../types';

type Props = QueryEditorProps<DataSource, MyQuery, MyDataSourceOptions>;

type QueryKind = 'range' | 'instant';

const QUERY_KINDS: Array<SelectableValue<QueryKind>> = [
  { label: 'Range', value: 'range' },
  { label: 'Instant', value: 'instant' },
];

const DEFAULT_MAX_DATA_POINTS = 1000;
const DEFAULT_AZURE_TIME_GRAIN = 'PT30M';

export function QueryEditor({ query, onChange, onRunQuery, datasource }: Props) {
  const shouldReset = shouldResetQueryForDatasource(query, datasource);

  React.useEffect(() => {
    if (shouldReset) {
      onChange({
        ...datasource.getDefaultQuery(CoreApp.Explore),
        refId: query.refId,
      } as MyQuery);
    }
  }, [datasource, onChange, query.refId, shouldReset]);

  if (shouldReset) {
    return (
      <Stack direction="column" gap={1}>
        <div>Resetting query for {datasource.getQueryUpstreamDatasourceType()} datasource</div>
      </Stack>
    );
  }

  if (datasource.isAzureMonitor()) {
    return (
      <AzureMonitorQueryEditor query={query} onChange={onChange} onRunQuery={onRunQuery} datasource={datasource} />
    );
  }

  if (!datasource.isPrometheus()) {
    return (
      <Stack direction="column" gap={1}>
        <div>Unsupported upstream datasource type: {datasource.getUpstreamDatasourceType() ?? 'unknown'}</div>
      </Stack>
    );
  }

  return (
    <PrometheusQueryEditor query={query} onChange={onChange} onRunQuery={onRunQuery} datasource={datasource} />
  );
}

function shouldResetQueryForDatasource(query: MyQuery, datasource: DataSource): boolean {
  const currentType = datasource.getQueryUpstreamDatasourceType();

  if (query.upstreamDatasourceType && query.upstreamDatasourceType !== currentType) {
    return true;
  }

  if (datasource.isAzureMonitor()) {
    return query.queryType !== 'Azure Monitor' || !!query.expr;
  }

  if (datasource.isPrometheus()) {
    return query.queryType === 'Azure Monitor';
  }

  return false;
}

function PrometheusQueryEditor({ query, onChange, onRunQuery, datasource }: Props) {
  const [metricNames, setMetricNames] = React.useState<string[]>([]);
  const [metricsLoading, setMetricsLoading] = React.useState(false);
  const kind: QueryKind = query.instant ? 'instant' : 'range';

  React.useEffect(() => {
    let cancelled = false;

    datasource
      .getMetricNames()
      .then((names) => {
        if (!cancelled) {
          setMetricNames(names);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setMetricsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [datasource]);

  const selectedMetric = React.useMemo<ComboboxOption<string> | null>(() => {
    if (!query.expr || !metricNames.includes(query.expr)) {
      return null;
    }

    return {
      label: query.expr,
      value: query.expr,
    };
  }, [metricNames, query.expr]);

  const onExprChange = (value: string) => {
    onChange(buildPrometheusQuery(query, datasource, { expr: value }));
  };

  const onMetricChange = (option: ComboboxOption<string> | null) => {
    onChange(buildPrometheusQuery(query, datasource, { expr: option?.value ?? '' }));
    onRunQuery();
  };

  const onKindChange = (value: QueryKind) => {
    const instant = value === 'instant';
    onChange(buildPrometheusQuery(query, datasource, { instant, range: !instant }));
    onRunQuery();
  };

  const loadMetricOptions = React.useCallback(
    (search: string) => {
      return datasource.getMetricOptions(search);
    },
    [datasource]
  );

  const onBeforeEditorMount = (monaco: Monaco) => {
    if (!monaco.languages.getLanguages().some((language) => language.id === 'promql')) {
      monaco.languages.register({ id: 'promql' });
    }
  };

  const onEditorDidMount = (editor: MonacoEditor, monaco: Monaco) => {
    // Run query on Ctrl/Cmd+Enter.
    editor.addAction({
      id: 'run-query',
      label: 'Run Query',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => onRunQuery(),
    });
  };

  return (
    <Stack direction="column" gap={1}>
      <InlineField label="Query type" labelWidth={16}>
        <RadioButtonGroup options={QUERY_KINDS} value={kind} onChange={onKindChange} />
      </InlineField>
      <InlineField label="Metric" labelWidth={16} grow tooltip="Pick an upstream metric name like in Grafana's native metric browsers">
        <Combobox
          value={selectedMetric}
          options={loadMetricOptions}
          onChange={onMetricChange}
          placeholder="Select a metric name"
          loading={metricsLoading}
          isClearable={true}
        />
      </InlineField>
      <InlineField label="Expression" labelWidth={16} grow tooltip="PromQL expression forwarded to the upstream datasource">
        <CodeEditor
          language="promql"
          value={query.expr ?? ''}
          onChange={onExprChange}
          onBeforeEditorMount={onBeforeEditorMount}
          onEditorDidMount={onEditorDidMount}
          getSuggestions={() => datasource.getMetricSuggestions()}
          height="100px"
          showMiniMap={false}
          showLineNumbers={false}
          monacoOptions={{
            quickSuggestions: true,
            scrollBeyondLastLine: false,
            suggestOnTriggerCharacters: true,
            wordWrap: 'on',
          }}
        />
      </InlineField>
    </Stack>
  );
}

function buildPrometheusQuery(query: MyQuery, datasource: DataSource, patch: Partial<MyQuery>): MyQuery {
  const { queryType, subscription, azureMonitor, ...prometheusQuery } = query;
  return {
    ...prometheusQuery,
    upstreamDatasourceType: datasource.getQueryUpstreamDatasourceType(),
    ...patch,
  };
}

function AzureMonitorQueryEditor({ query, onChange, onRunQuery, datasource }: Props) {
  const [subscriptions, setSubscriptions] = React.useState<Array<{ displayName?: string; subscriptionId?: string }>>(
    []
  );
  const [resourceGroups, setResourceGroups] = React.useState<Array<{ name?: string }>>([]);
  const [resources, setResources] = React.useState<
    Array<{ id: string; name: string; type: string; resourceGroup: string; location?: string }>
  >([]);
  const [metricDefinitions, setMetricDefinitions] = React.useState<
    Array<{
      name?: { value?: string; localizedValue?: string };
      primaryAggregationType?: string;
      supportedAggregationTypes?: string[];
      metricAvailabilities?: Array<{ timeGrain?: string }>;
    }>
  >([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = React.useState(true);
  const [resourceGroupsLoading, setResourceGroupsLoading] = React.useState(false);
  const [resourcesLoading, setResourcesLoading] = React.useState(false);
  const [metricsLoading, setMetricsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const selectedResource = query.azureMonitor?.resources?.[0];
  const subscription = query.subscription ?? selectedResource?.subscription ?? '';
  const resourceGroup = selectedResource?.resourceGroup ?? '';
  const resourceName = selectedResource?.resourceName ?? '';
  const metricNamespace = query.azureMonitor?.metricNamespace ?? selectedResource?.metricNamespace ?? '';
  const metricName = query.azureMonitor?.metricName ?? '';
  const aggregation = query.azureMonitor?.aggregation ?? '';
  const timeGrain =
    query.azureMonitor?.timeGrain && query.azureMonitor.timeGrain !== 'auto'
      ? query.azureMonitor.timeGrain
      : DEFAULT_AZURE_TIME_GRAIN;
  const selectedResourceItem = resources.find(
    (resource) => resource.name === resourceName && resource.type.toLowerCase() === metricNamespace.toLowerCase()
  );
  const selectedMetricDefinition = metricDefinitions.find((metric) => metric.name?.value === metricName);

  const generatedQuery = React.useMemo(
    () =>
      buildAzureMonitorQuery(query, {
        subscription,
        resourceGroup,
        metricNamespace,
        resourceName,
        metricName,
        aggregation,
        timeGrain,
      }),
    [aggregation, metricName, metricNamespace, query, resourceGroup, resourceName, subscription, timeGrain]
  );

  const updateAzureQuery = React.useCallback((patch: Partial<AzureQueryFields>) => {
    onChange(
      buildAzureMonitorQuery(query, {
        subscription,
        resourceGroup,
        metricNamespace,
        resourceName,
        metricName,
        aggregation,
        timeGrain,
        ...patch,
      })
    );
  }, [aggregation, metricName, metricNamespace, onChange, query, resourceGroup, resourceName, subscription, timeGrain]);

  React.useEffect(() => {
    let cancelled = false;

    datasource
      .getAzureMonitorSubscriptions()
      .then((items) => {
        if (!cancelled) {
          setSubscriptions(items);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSubscriptionsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [datasource]);

  React.useEffect(() => {
    if (!subscription && subscriptions[0]?.subscriptionId) {
      updateAzureQuery({ subscription: subscriptions[0].subscriptionId });
    }
  }, [subscription, subscriptions, updateAzureQuery]);

  React.useEffect(() => {
    let cancelled = false;

    datasource
      .getAzureMonitorResourceGroups(subscription)
      .then((items) => {
        if (!cancelled) {
          setResourceGroups(items);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setResourceGroupsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [datasource, subscription]);

  React.useEffect(() => {
    let cancelled = false;

    datasource
      .getAzureMonitorResources(subscription, resourceGroup)
      .then((items) => {
        if (!cancelled) {
          setResources(items);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setResourcesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [datasource, resourceGroup, subscription]);

  React.useEffect(() => {
    let cancelled = false;

    if (!selectedResourceItem?.id) {
      return;
    }

    datasource
      .getAzureMonitorMetricDefinitions(selectedResourceItem.id)
      .then((items) => {
        if (!cancelled) {
          setMetricDefinitions(items);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setMetricsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [datasource, selectedResourceItem?.id]);

  const subscriptionOptions = React.useMemo<Array<ComboboxOption<string>>>(
    () =>
      subscriptions.map((item) => ({
        label: item.displayName ? `${item.displayName} (${item.subscriptionId})` : item.subscriptionId ?? '',
        value: item.subscriptionId ?? '',
      })),
    [subscriptions]
  );

  const resourceGroupOptions = React.useMemo<Array<ComboboxOption<string>>>(
    () => resourceGroups.map((item) => ({ label: item.name ?? '', value: item.name ?? '' })),
    [resourceGroups]
  );

  const resourceOptions = React.useMemo<Array<ComboboxOption<string>>>(
    () =>
      resources.map((resource) => ({
        label: `${resource.name} (${resource.type})`,
        value: resource.id,
      })),
    [resources]
  );

  const metricOptions = React.useMemo<Array<ComboboxOption<string>>>(
    () =>
      metricDefinitions.map((metric) => {
        const value = metric.name?.value ?? '';
        const label = metric.name?.localizedValue ? `${metric.name.localizedValue} (${value})` : value;
        return { label, value };
      }),
    [metricDefinitions]
  );

  const aggregationOptions = React.useMemo<Array<ComboboxOption<string>>>(() => {
    const values = selectedMetricDefinition?.supportedAggregationTypes ?? [];
    return values.map((value) => ({ label: value, value }));
  }, [selectedMetricDefinition]);

  const onSubscriptionChange = (option: SelectableValue<string> | null) => {
    updateAzureQuery({
      subscription: option?.value ?? '',
      resourceGroup: '',
      metricNamespace: '',
      resourceName: '',
      metricName: '',
      aggregation: '',
    });
  };

  const onResourceGroupChange = (option: SelectableValue<string> | null) => {
    updateAzureQuery({
      resourceGroup: option?.value ?? '',
      metricNamespace: '',
      resourceName: '',
      metricName: '',
      aggregation: '',
    });
  };

  const onResourceChange = (option: SelectableValue<string> | null) => {
    const resource = resources.find((item) => item.id === option?.value);
    const parsed = resource ? parseAzureResourceId(resource.id) : null;

    updateAzureQuery({
      resourceGroup: resource?.resourceGroup ?? resourceGroup,
      metricNamespace: parsed?.metricNamespace ?? resource?.type ?? '',
      resourceName: parsed?.resourceName ?? resource?.name ?? '',
      metricName: '',
      aggregation: '',
    });
  };

  const onMetricChange = (option: SelectableValue<string> | null) => {
    const metric = metricDefinitions.find((item) => item.name?.value === option?.value);
    updateAzureQuery({
      metricName: option?.value ?? '',
      aggregation: metric?.primaryAggregationType ?? metric?.supportedAggregationTypes?.[0] ?? '',
      timeGrain: metric?.metricAvailabilities?.[0]?.timeGrain ?? timeGrain,
    });
  };

  const runAzureQuery = () => {
    onChange(generatedQuery);
    setTimeout(onRunQuery, 0);
  };

  const canRun = !!(subscription && resourceGroup && resourceName && metricNamespace && metricName && aggregation);

  return (
    <Stack direction="column" gap={1}>
      {error && <div>Failed to load subscriptions: {error}</div>}
      <InlineField label="Subscription" labelWidth={18} grow>
        <Select
          value={subscriptionOptions.find((option) => option.value === subscription) ?? null}
          options={subscriptionOptions}
          onChange={onSubscriptionChange}
          loading={subscriptionsLoading}
          isClearable={false}
        />
      </InlineField>
      <InlineField label="Resource group" labelWidth={18} grow>
        <Select
          value={resourceGroupOptions.find((option) => option.value === resourceGroup) ?? null}
          options={resourceGroupOptions}
          onChange={onResourceGroupChange}
          loading={resourceGroupsLoading}
          disabled={!subscription}
          isClearable={true}
        />
      </InlineField>
      <InlineField label="Resource" labelWidth={18} grow>
        <Select
          value={selectedResourceItem ? { label: `${selectedResourceItem.name} (${selectedResourceItem.type})`, value: selectedResourceItem.id } : null}
          options={resourceOptions}
          onChange={onResourceChange}
          loading={resourcesLoading}
          disabled={!resourceGroup}
          isClearable={true}
        />
      </InlineField>
      <InlineField label="Type" labelWidth={18} grow>
        <Input value={metricNamespace} readOnly />
      </InlineField>
      <InlineField label="Region" labelWidth={18} grow>
        <Input value={selectedResourceItem?.location ?? ''} readOnly />
      </InlineField>
      <InlineField label="Metric" labelWidth={18} grow>
        <Select
          value={metricOptions.find((option) => option.value === metricName) ?? (metricName ? { label: metricName, value: metricName } : null)}
          options={metricOptions}
          onChange={onMetricChange}
          loading={metricsLoading}
          disabled={!selectedResourceItem}
          isClearable={false}
        />
      </InlineField>
      <InlineField label="Aggregation" labelWidth={18} grow>
        <Select
          value={aggregationOptions.find((option) => option.value === aggregation) ?? (aggregation ? { label: aggregation, value: aggregation } : null)}
          options={aggregationOptions}
          onChange={(option) => updateAzureQuery({ aggregation: option?.value ?? '' })}
          disabled={!metricName}
          isClearable={false}
        />
      </InlineField>
      <InlineField label="Time grain" labelWidth={18} grow tooltip="Azure ISO-8601 duration such as PT30M.">
        <Input
          value={timeGrain}
          placeholder={DEFAULT_AZURE_TIME_GRAIN}
          onChange={(event) => updateAzureQuery({ timeGrain: event.currentTarget.value })}
        />
      </InlineField>
      <Button type="button" onClick={runAzureQuery} disabled={!canRun}>
        Run Azure Monitor query
      </Button>
      <details>
        <summary>Generated Azure Monitor query JSON</summary>
        <pre>{JSON.stringify(generatedQuery, null, 2)}</pre>
      </details>
    </Stack>
  );
}

interface AzureQueryFields {
  subscription: string;
  resourceGroup: string;
  metricNamespace: string;
  resourceName: string;
  metricName: string;
  aggregation: string;
  timeGrain: string;
}

function buildAzureMonitorQuery(baseQuery: MyQuery, fields: AzureQueryFields): MyQuery {
  const resource = {
    subscription: fields.subscription,
    resourceGroup: fields.resourceGroup,
    metricNamespace: fields.metricNamespace,
    resourceName: fields.resourceName,
  };

  const normalizedTimeGrain = fields.timeGrain.trim().toUpperCase();
  const azureMonitor = {
    resources: [resource],
    metricNamespace: fields.metricNamespace,
    metricName: fields.metricName,
    aggregation: fields.aggregation,
    timeGrain: normalizedTimeGrain || 'auto',
    dimensionFilters: [],
  };

  return {
    ...baseQuery,
    refId: baseQuery.refId,
    queryType: 'Azure Monitor',
    upstreamDatasourceType: 'grafana-azure-monitor-datasource',
    subscription: fields.subscription,
    azureMonitor,
    ...(normalizedTimeGrain ? { intervalMs: isoDurationToMs(normalizedTimeGrain) } : {}),
    maxDataPoints: DEFAULT_MAX_DATA_POINTS,
  };
}

function parseAzureResourceId(id: string): { metricNamespace: string; resourceName: string } | null {
  const segments = id.split('/').filter(Boolean);
  const providerIndex = segments.findIndex((segment) => segment.toLowerCase() === 'providers');
  if (providerIndex === -1 || providerIndex + 3 >= segments.length) {
    return null;
  }

  const provider = segments[providerIndex + 1];
  const rest = segments.slice(providerIndex + 2);
  const types: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i]) {
      types.push(rest[i]);
    }
    if (rest[i + 1]) {
      names.push(rest[i + 1]);
    }
  }

  return {
    metricNamespace: [provider, ...types].join('/'),
    resourceName: names.join('/'),
  };
}

function isoDurationToMs(value: string): number | undefined {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) {
    return undefined;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}
