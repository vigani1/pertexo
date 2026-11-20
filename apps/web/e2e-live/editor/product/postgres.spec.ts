import { postgresCredentialSchema } from '@pertexo/contracts';
import { expect } from '@playwright/test';
import { test } from './account';
import { openNewEditorWorkspace } from '../../support/ordinary-editor-session';
import { fillOwnedHttpCredential } from '../../support/http-secret-actions';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

test.use({ actionTimeout: 10_000 });

test('creates a PostgreSQL connection, runs a Database query and reads its rows', async ({
  page,
  request,
}) => {
  const controlOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (controlOrigin === undefined) throw new Error('Use the owned API fixture');
  const material = await request.get(`${controlOrigin}/postgres-credential`);
  expect(material.status()).toBe(200);
  const credential = postgresCredentialSchema.parse(await material.json());
  const workspaceId = await openNewEditorWorkspace(
    page,
    'PostgreSQL workspace',
  );
  await page.goto(`/w/${workspaceId}/connections`);
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  const chooser = page.getByRole('dialog', {
    name: 'Add a connection',
    exact: true,
  });
  await chooser
    .getByRole('button', { name: 'Connect PostgreSQL', exact: true })
    .click();
  const form = page.getByRole('dialog', {
    name: 'Connect PostgreSQL',
    exact: true,
  });
  await form.getByLabel('Host', { exact: true }).fill(credential.host);
  await form.getByLabel('Port', { exact: true }).fill(String(credential.port));
  await form.getByLabel('Database', { exact: true }).fill(credential.database);
  await form.getByLabel('User', { exact: true }).fill(credential.user);
  await fillOwnedHttpCredential(
    form.getByLabel('Password', { exact: true }),
    credential.password,
  );
  await form.getByRole('radio', { name: 'Disable', exact: true }).click();
  await form
    .getByRole('checkbox', { name: 'Read-only connection', exact: true })
    .check();
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .getByLabel('Connection name', { exact: true })
    .fill('Reporting PostgreSQL');
  await page
    .getByRole('button', { name: 'Save and test', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Test connection', exact: true })
    .click();
  await expect(
    page.getByText('PostgreSQL answered the test query.', { exact: true }),
  ).toBeVisible();

  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Read PostgreSQL rows',
  );
  await addSingleStep(page, path, /^Database\b/u, 'Read report');
  await page
    .getByLabel('SQL', { exact: true })
    .fill(
      "select 'first database row' as report\nunion all select 'second database row'",
    );
  await page.getByLabel('PostgreSQL connection', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Reporting PostgreSQL', exact: true })
    .click();
  await publishSingleStep(page, path);
  const runId = await startSingleStep(page, {});
  await waitForRun(page, workspaceId, runId, 'succeeded');
  await page.getByRole('button', { name: /^Read report: Succeeded/u }).click();
  const details = page.getByRole('complementary', { name: 'Step details' });
  await expect(details).toContainText('first database row');
  await expect(details).toContainText('second database row');
  expect(await page.content()).not.toContain(credential.password);
});
