import type { Locator, Page } from '@playwright/test';
export async function addBrowserInput({
  page,
  scope = page,
  key,
  source,
}: Readonly<{
  page: Page;
  scope?: Page | Locator;
  key: string;
  source: (row: Locator) => Promise<void>;
}>) {
  await scope.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await scope.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = scope
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill(key);
  await source(row);
  await page.keyboard.press('Tab');
}
export async function selectLoopItem(row: Locator) {
  await row.getByRole('button', { name: 'Loop item', exact: true }).click();
  await row.getByLabel('Path in it', { exact: true }).fill('$');
}

export async function selectLoopPosition({
  page,
  row,
}: Readonly<{ page: Page; row: Locator }>) {
  await row.getByRole('button', { name: 'Loop item', exact: true }).click();
  await row.getByLabel('Read', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Its position (0, 1, 2…)', exact: true })
    .click();
  await row.getByLabel('Path in it', { exact: true }).fill('$');
}

export async function mapBrowserInput({
  page,
  scope = page,
  field,
  source,
  path,
}: Readonly<{
  page: Page;
  scope?: Page | Locator;
  field: string;
  source: string;
  path: string;
}>) {
  await addBrowserInput({
    page,
    scope,
    key: field,
    source: async (row) => {
      if (source === 'Run input') {
        await row
          .getByRole('button', { name: 'Run input', exact: true })
          .click();
        await row.getByLabel('Run input path', { exact: true }).fill(path);
      } else {
        await row
          .getByRole('button', { name: 'Step output', exact: true })
          .click();
        await row.getByLabel('Source step', { exact: true }).click();
        await page.getByRole('option', { name: source, exact: true }).click();
        await row.getByLabel('Output path', { exact: true }).fill(path);
      }
    },
  });
}
