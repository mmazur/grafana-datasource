import React, { ChangeEvent } from 'react';
import { Combobox, InlineField, Input, SecretInput, TextArea, type ComboboxOption } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { AuthMode, MyDataSourceOptions, MySecureJsonData } from '../types';

interface Props extends DataSourcePluginOptionsEditorProps<MyDataSourceOptions, MySecureJsonData> {}

const AUTH_MODES: Array<ComboboxOption<AuthMode>> = [
  { label: 'None', value: 'none' },
  { label: 'Bearer token', value: 'bearer' },
  { label: 'Shell command', value: 'shellcmd' },
];

const LABEL_WIDTH = 20;

export function ConfigEditor(props: Props) {
  const { onOptionsChange, options } = props;
  const { jsonData, secureJsonFields, secureJsonData } = options;
  const authMode: AuthMode = jsonData.authMode ?? 'none';

  const onJsonChange = (patch: Partial<MyDataSourceOptions>) => {
    onOptionsChange({ ...options, jsonData: { ...jsonData, ...patch } });
  };

  const onUpstreamUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    onJsonChange({ upstreamUrl: event.target.value });
  };

  const onUpstreamDsUidChange = (event: ChangeEvent<HTMLInputElement>) => {
    onJsonChange({ upstreamDatasourceUid: event.target.value });
  };

  const onUpstreamDsTypeChange = (event: ChangeEvent<HTMLInputElement>) => {
    onJsonChange({ upstreamDatasourceType: event.target.value });
  };

  const onAuthModeChange = (value: ComboboxOption<AuthMode> | null) => {
    onJsonChange({ authMode: value?.value ?? 'none' });
  };

  const onShellCmdChange = (event: ChangeEvent<HTMLInputElement>) => {
    onJsonChange({ shellCmd: event.target.value });
  };

  // Args are edited one-per-line; blank lines are dropped.
  const onShellArgsChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const shellArgs = event.target.value.split('\n').filter((a) => a.length > 0);
    onJsonChange({ shellArgs });
  };

  const onTokenJsonFieldChange = (event: ChangeEvent<HTMLInputElement>) => {
    onJsonChange({ tokenJsonField: event.target.value });
  };

  const onTokenTtlChange = (event: ChangeEvent<HTMLInputElement>) => {
    const parsed = Number(event.target.value);
    onJsonChange({ tokenTtlSeconds: Number.isFinite(parsed) ? parsed : 0 });
  };

  const onBearerTokenChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({ ...options, secureJsonData: { bearerToken: event.target.value } });
  };

  const onResetBearerToken = () => {
    onOptionsChange({
      ...options,
      secureJsonFields: { ...options.secureJsonFields, bearerToken: false },
      secureJsonData: { ...options.secureJsonData, bearerToken: '' },
    });
  };

  return (
    <>
      <InlineField
        label="Upstream URL"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip={'Base URL of the upstream Grafana to proxy to'}
      >
        <Input
          id="config-editor-upstream-url"
          onChange={onUpstreamUrlChange}
          value={jsonData.upstreamUrl ?? ''}
          placeholder="https://example.grafana.azure.com"
          width={60}
        />
      </InlineField>

      <InlineField
        label="Upstream DS UID"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip={'UID of the single upstream datasource this instance proxies queries to'}
      >
        <Input
          id="config-editor-upstream-ds-uid"
          onChange={onUpstreamDsUidChange}
          value={jsonData.upstreamDatasourceUid ?? ''}
          placeholder="staging-services"
          width={60}
        />
      </InlineField>

      <InlineField
        label="Upstream DS type"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip={'Type of the upstream datasource (e.g. prometheus)'}
      >
        <Input
          id="config-editor-upstream-ds-type"
          onChange={onUpstreamDsTypeChange}
          value={jsonData.upstreamDatasourceType ?? ''}
          placeholder="prometheus"
          width={40}
        />
      </InlineField>

      <InlineField label="Auth mode" labelWidth={LABEL_WIDTH} interactive tooltip={'How to authenticate to the upstream'}>
        <Combobox
          options={AUTH_MODES}
          value={AUTH_MODES.find((option) => option.value === authMode) ?? null}
          onChange={onAuthModeChange}
          width={40}
          isClearable={false}
        />
      </InlineField>

      {authMode === 'bearer' && (
        <InlineField label="Bearer token" labelWidth={LABEL_WIDTH} interactive tooltip={'Secure field (backend only)'}>
          <SecretInput
            required
            id="config-editor-bearer-token"
            isConfigured={secureJsonFields.bearerToken}
            value={secureJsonData?.bearerToken}
            placeholder="Enter the bearer token"
            width={60}
            onReset={onResetBearerToken}
            onChange={onBearerTokenChange}
          />
        </InlineField>
      )}

      {authMode === 'shellcmd' && (
        <>
          <InlineField
            label="Command"
            labelWidth={LABEL_WIDTH}
            interactive
            tooltip={'Executable that prints a token. Use an absolute path — the backend subprocess runs with an empty PATH.'}
          >
            <Input
              id="config-editor-shell-cmd"
              onChange={onShellCmdChange}
              value={jsonData.shellCmd ?? ''}
              placeholder="az"
              width={60}
            />
          </InlineField>

          <InlineField
            label="Arguments"
            labelWidth={LABEL_WIDTH}
            interactive
            tooltip={'One argument per line'}
          >
            <TextArea
              id="config-editor-shell-args"
              onChange={onShellArgsChange}
              value={(jsonData.shellArgs ?? []).join('\n')}
              placeholder={'account\nget-access-token\n--resource\n<id>\n-o\njson'}
              rows={6}
              cols={58}
            />
          </InlineField>

          <InlineField
            label="Token JSON field"
            labelWidth={LABEL_WIDTH}
            interactive
            tooltip={'If set, parse stdout as JSON and read the token from this field; otherwise use raw stdout'}
          >
            <Input
              id="config-editor-token-json-field"
              onChange={onTokenJsonFieldChange}
              value={jsonData.tokenJsonField ?? ''}
              placeholder="accessToken"
              width={40}
            />
          </InlineField>

          <InlineField
            label="Token cache (seconds)"
            labelWidth={LABEL_WIDTH}
            interactive
            tooltip={'Reuse the minted token for this many seconds before running the command again. 0 disables caching.'}
          >
            <Input
              id="config-editor-token-ttl"
              type="number"
              onChange={onTokenTtlChange}
              value={jsonData.tokenTtlSeconds ?? ''}
              placeholder="1800"
              width={40}
            />
          </InlineField>
        </>
      )}
    </>
  );
}
