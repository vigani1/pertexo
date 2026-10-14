import { expect, type Page, type APIRequestContext } from '@playwright/test';
import { connectionResponseSchema } from '@pertexo/contracts';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../ordinary-editor-session';
import { fillOwnedHttpCredential } from '../http-secret-actions';

export async function createOwnedHttpConnection(
  page: Page,
  request: APIRequestContext,
) {
  const controlOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (controlOrigin === undefined)
    throw new Error('Run through the owned API fixture');
  await registerEditorUser(
    page,
    request,
    controlOrigin,
    'Controlled HTTP owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Controlled HTTP workspace',
  );
  // This private control response is transient test material, not VITE configuration.
  const material = await request.get(`${controlOrigin}/http-credential`);
  if (material.status() !== 200)
    throw new Error('Owned credential unavailable');
  const value: unknown = await material.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('authorizationValue' in value) ||
    typeof value.authorizationValue !== 'string'
  )
    throw new Error('Owned credential invalid');
  await page.goto(`/w/${workspaceId}/connections`);
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  const chooser = page.getByRole('dialog', {
    name: 'Add a connection',
    exact: true,
  });
  await expect(chooser).toBeVisible();
  await chooser
    .getByRole('button', { name: 'Connect HTTP', exact: true })
    .click();
  const credential = page.getByRole('dialog', {
    name: 'Connect HTTP',
    exact: true,
  });
  await expect(
    credential.getByLabel('Header 1 name', { exact: true }),
  ).toBeVisible();
  await credential
    .getByLabel('Header 1 name', { exact: true })
    .fill('Authorization');
  await fillOwnedHttpCredential(
    credential.getByLabel('Header 1 value', { exact: true }),
    value.authorizationValue,
  );
  await credential
    .getByRole('button', { name: 'Continue', exact: true })
    .click();
  await page
    .getByLabel('Connection name', { exact: true })
    .fill('Owned HTTP credential');
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/v1/workspaces/${workspaceId}/connections`,
  );
  await page
    .getByRole('button', { name: 'Save and test', exact: true })
    .click();
  const savedResponse = await saved;
  if (savedResponse.status() !== 201)
    throw new Error('Owned credential creation failed');
  const connection = connectionResponseSchema.parse(await savedResponse.json());
  await page.getByRole('button', { name: 'Skip test', exact: true }).click();
  return { controlOrigin, workspaceId, connection };
}
