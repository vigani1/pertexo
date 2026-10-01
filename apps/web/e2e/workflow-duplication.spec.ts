import { expect, test } from '@playwright/test';
import {
  addCsrfCookie,
  currentEtag,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspace,
  workspaceId,
} from './workflow-editor-support';

test('keeps a workflow copy exact through retry and postflight outages until verified recovery', async ({
  context,
  page,
}) => {
  const remote = remoteDraft();
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    accessibleWorkspace: {
      ...workspace,
      capabilities: [...workspace.capabilities, 'workflow:create'],
    },
  });
  const destination = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${destination}**`,
    (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: {
          type: 'urn:pertexo:problem:workflow.not_found',
          title: 'Workflow unavailable',
          status: 404,
          code: 'workflow.not_found',
          requestId: 'fixture-destination',
        },
      }),
  );
  const attempts: {
    body: unknown;
    key: string | undefined;
    tag: string | undefined;
  }[] = [];
  let workspaceUnavailable = false;
  let identityUnavailable = false;
  const unavailable = (status: number) => ({
    status,
    contentType: 'application/problem+json',
    json: {
      type: 'urn:pertexo:problem:platform.unavailable',
      title: 'Try later',
      status,
      code: 'platform.unavailable',
      requestId: 'fixture-outage',
    },
  });
  await page.route('**/v1/workspaces?**', async (route) => {
    if (workspaceUnavailable) await route.fulfill(unavailable(429));
    else await route.fallback();
  });
  await page.route('**/v1/users/me', async (route) => {
    if (identityUnavailable) await route.abort('failed');
    else await route.fallback();
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/duplicate`,
    async (route) => {
      const request = route.request();
      attempts.push({
        body: request.postDataJSON() as unknown,
        key: request.headers()['idempotency-key'],
        tag: request.headers()['if-match'],
      });
      if (attempts.length === 1) await route.abort('failed');
      else if (attempts.length === 2) await route.fulfill(unavailable(503));
      else {
        identityUnavailable = attempts.length === 3;
        await route.fulfill({ status: 201, json: { workflowId: destination } });
      }
    },
  );
  await page.goto(editorUrl);
  await page.getByRole('button', { name: 'Duplicate…', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Duplicate workflow',
    exact: true,
  });
  await expect(
    dialog.getByText(/Source: saved draft revision 1/u),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByLabel('Copy name').fill('An independent copy');
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/pertexo-f05-duplicate-mobile.png' });
  await dialog
    .getByRole('button', { name: 'Duplicate workflow', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Retry exact copy' }),
  ).toBeEnabled();
  await expect(dialog.getByLabel('Copy name')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(editorUrl);
  workspaceUnavailable = true;
  await dialog.getByRole('button', { name: 'Retry exact copy' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry exact copy' }),
  ).toBeEnabled();
  expect(attempts).toHaveLength(1);
  workspaceUnavailable = false;
  await dialog.getByRole('button', { name: 'Retry exact copy' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry exact copy' }),
  ).toBeEnabled();
  await expect(dialog.getByText(/Nothing was changed/u)).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  await dialog.getByRole('button', { name: 'Retry exact copy' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry exact copy' }),
  ).toBeEnabled();
  expect(attempts).toHaveLength(3);
  await expect(page).toHaveURL(editorUrl);
  await expect(dialog.getByLabel('Copy name')).toBeDisabled();
  identityUnavailable = false;
  await dialog.getByRole('button', { name: 'Retry exact copy' }).click();
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows/${destination}`);
  expect(attempts).toHaveLength(4);
  for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
  expect(attempts[0]?.tag).toBe(currentEtag(remote));
  expect(attempts[0]?.body).toEqual({
    name: 'An independent copy',
    source: { kind: 'draft' },
  });
});
