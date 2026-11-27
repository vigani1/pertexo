import type { Page } from '@playwright/test';

export async function openWorkflowAction(
  page: Page,
  name: 'Export…' | 'Input cases' | 'Duplicate…',
) {
  await page
    .getByRole('button', { name: 'More workflow actions', exact: true })
    .click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
