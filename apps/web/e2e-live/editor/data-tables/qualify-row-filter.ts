import { expect, type Page } from '@playwright/test';

export async function qualifyRowFilter(page: Page) {
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  const filter = page.getByRole('dialog', {
    name: 'Filter rows',
    exact: true,
  });
  await filter
    .getByRole('textbox', { name: 'Value', exact: true })
    .fill('missing-order');
  await filter
    .getByRole('button', { name: 'Apply filter', exact: true })
    .click();
  await expect(filter).toBeHidden();
  await expect(
    page.getByText('No rows match this filter. Try a different filter.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('0 matching rows', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
}
