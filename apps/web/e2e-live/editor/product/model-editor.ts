import { expect, type Page, type TestInfo } from '@playwright/test';
import { fillOwnedHttpCredential } from '../../support/http-secret-actions';
import { baseUrl, key } from './model-provider';

export async function connectModel(page: Page, workspace: string) {
  await page.goto(`/w/${workspace}/connections`);
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Add a connection', exact: true })
    .getByRole('button', { name: 'Connect AI', exact: true })
    .click();
  const form = page.getByRole('dialog', { name: 'Connect AI', exact: true });
  await form.getByRole('radio', { name: 'Ollama', exact: true }).click();
  const url = form.getByLabel('API base URL', { exact: true });
  await expect(url).toHaveAttribute('aria-required', 'true');
  await form.getByRole('radio', { name: 'vLLM', exact: true }).click();
  await expect(url).toHaveAttribute('aria-required', 'true');
  await url.fill(baseUrl);
  const secret = form.getByLabel('API key', { exact: true });
  await expect(secret).toHaveAttribute('type', 'password');
  await fillOwnedHttpCredential(secret, key);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Order model');
  await page
    .getByRole('button', { name: 'Save and test', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Test connection', exact: true })
    .click();
  await expect(
    page.getByText('AI accepted the API key.', { exact: true }),
  ).toBeVisible();
}

export async function modelScreenshots(
  page: Page,
  info: TestInfo,
  title: string,
) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      colorScheme,
    );
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(`${title}-${colorScheme}.png`),
    });
  }
}
