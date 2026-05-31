import { test, expect } from '@grafana/plugin-e2e';

test('smoke: should render query editor with code editor and query type toggle', async ({
  panelEditPage,
  readProvisionedDataSource,
}) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await panelEditPage.datasource.set(ds.name);
  const row = panelEditPage.getQueryEditorRow('A');
  await expect(row.getByRole('combobox', { name: 'Metric' })).toBeVisible();
  await expect(row.getByRole('textbox', { name: /Editor content/ })).toBeVisible();
  await expect(row.getByText('Range')).toBeVisible();
  await expect(row.getByText('Instant')).toBeVisible();
});

test('query type defaults to Range', async ({
  panelEditPage,
  readProvisionedDataSource,
}) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await panelEditPage.datasource.set(ds.name);
  const row = panelEditPage.getQueryEditorRow('A');
  await expect(row.getByRole('textbox', { name: /Editor content/ })).toBeVisible();
  await expect(row.getByRole('radio', { name: 'Range' })).toHaveAttribute('checked', '');
});
