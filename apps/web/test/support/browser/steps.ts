import type { Page } from '@playwright/test';

export async function openStepSetup(
  page: Page,
  { nodeId, width }: Readonly<{ nodeId: string; width: number }>,
) {
  await page.getByTestId(`rf__node-${nodeId}`).click();
  if (width < 1024)
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
}

export async function addRunInputMapping(
  page: Page,
  { field, path }: Readonly<{ field: string; path: string }>,
) {
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill(field);
  await row.getByRole('button', { name: 'Run input', exact: true }).click();
  await row.getByLabel('Run input path', { exact: true }).fill(path);
  await page.keyboard.press('Tab');
}
