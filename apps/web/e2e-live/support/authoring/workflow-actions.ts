import type { Page } from '@playwright/test';

/**
 * Export, Input cases and Duplicate are header buttons from 2xl up and items
 * in the header's ⋯ menu below it.
 */
export async function openWorkflowAction(
  page: Page,
  name: 'Export…' | 'Input cases' | 'Duplicate…',
) {
  if ((page.viewportSize()?.width ?? 1280) < 1536) {
    await page
      .getByRole('button', { name: 'More workflow actions', exact: true })
      .click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  } else {
    await page.getByRole('button', { name, exact: true }).click();
  }
}
