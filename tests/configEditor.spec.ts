import { test, expect } from '@grafana/plugin-e2e';
import { MyDataSourceOptions, MySecureJsonData } from '../src/types';

test('smoke: should render config editor', async ({ createDataSourceConfigPage, readProvisionedDataSource, page }) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await createDataSourceConfigPage({ type: ds.type });
  await expect(page.getByRole('textbox', { name: 'Upstream URL' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Auth mode' })).toBeVisible();
});

test('selecting "Shell command" auth mode reveals the command fields', async ({
  createDataSourceConfigPage,
  readProvisionedDataSource,
  page,
}) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await createDataSourceConfigPage({ type: ds.type });

  // Hidden until the shellcmd mode is selected.
  await expect(page.getByRole('textbox', { name: 'Command' })).toBeHidden();

  await page.getByRole('combobox', { name: 'Auth mode' }).click();
  await page.getByText('Shell command', { exact: true }).click();

  await expect(page.getByRole('textbox', { name: 'Command' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Arguments' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Token JSON field' })).toBeVisible();
});

test('selecting "Bearer token" auth mode reveals the secret field', async ({
  createDataSourceConfigPage,
  readProvisionedDataSource,
  page,
}) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await createDataSourceConfigPage({ type: ds.type });

  await page.getByRole('combobox', { name: 'Auth mode' }).click();
  await page.getByText('Bearer token', { exact: true }).click();

  await expect(page.getByRole('textbox', { name: 'Bearer token' })).toBeVisible();
});

test('"Save & test" should be successful for a valid (no-auth) configuration', async ({
  createDataSourceConfigPage,
  readProvisionedDataSource,
  page,
}) => {
  const ds = await readProvisionedDataSource<MyDataSourceOptions, MySecureJsonData>({ fileName: 'datasources.yml' });
  const configPage = await createDataSourceConfigPage({ type: ds.type });
  await page.getByRole('textbox', { name: 'Upstream URL' }).fill(ds.jsonData.upstreamUrl ?? '');
  await expect(configPage.saveAndTest()).toBeOK();
});
