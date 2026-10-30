import { test } from '../../support/browser-fixture';
import { createOwnedHttpConnection } from '../../support/authoring/http-connection';
import {
  addSingleStep,
  createEditorWorkflow,
  startSingleStep,
} from '../../support/authoring/single-step';
import { expect, publishNext, runReaches } from './steps';

// Several real services behind one browser; this stays honest on a busy machine.
test.describe.configure({ timeout: 120_000 });

// product-ux-05: the panel says "answered with an error", with no status, body or URL.
test('a failed HTTP step shows its status, response and URL, without the secrets', async ({
  page,
  request,
}) => {
  test.fail();
  const { controlOrigin, workspaceId } = await createOwnedHttpConnection(
    page,
    request,
  );
  const credential = await request.get(`${controlOrigin}/http-credential`);
  const { authorizationValue } = (await credential.json()) as {
    authorizationValue: string;
  };
  const path = await createEditorWorkflow(page, workspaceId, 'Fetch an order');
  const httpId = await addSingleStep(
    page,
    path,
    /HTTP request/u,
    'Fetch the order',
  );
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page.getByRole('button', { name: 'Edit as JSON', exact: true }).click();
  await page.getByLabel('Setup as JSON', { exact: true }).fill(
    JSON.stringify({
      method: 'GET',
      url: 'https://pertexo-controlled-action.example.test/exploded?order=a-17',
      headers: {},
      timeoutMillis: 5000,
      maxRedirects: 0,
      maxResponseBytes: 4096,
      inlineResponseBytes: 4096,
    }),
  );
  await page.keyboard.press('Tab');
  await page.getByLabel('HTTP connection', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Owned HTTP credential', exact: true })
    .click();
  await publishNext(page, 1);
  const runId = await startSingleStep(page, {});
  const failed = await runReaches(page, workspaceId, runId, 'failed');
  expect(failed.nodes.find(({ nodeId }) => nodeId === httpId)?.status).toBe(
    'failed',
  );
  await page.getByRole('button', { name: /^Fetch the order: Failed/u }).click();
  const details = page.getByRole('complementary', { name: 'Step details' });
  await expect(details).toContainText('500');
  await expect(details).toContainText('upstream exploded');
  await expect(details).toContainText(
    'pertexo-controlled-action.example.test/exploded',
  );
  // The service echoed the connection's credential; it must not come back out.
  const shown = await page.content();
  expect(shown).not.toContain(authorizationValue);
  const stored = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${runId}`,
  );
  const body = await stored.text();
  expect(body).not.toContain(authorizationValue);
});
