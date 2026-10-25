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
