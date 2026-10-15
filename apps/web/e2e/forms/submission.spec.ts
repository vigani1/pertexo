import { test, expect } from '@playwright/test';
import { formConfigSchema } from '@pertexo/workflow-model';
import {
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowId,
} from '../workflow-editor/support';
const versionId = '22222222-2222-4222-8222-222222222222';
const publicId = '11111111-1111-4111-8111-111111111111';
const capability = 'a'.repeat(43);
const form = formConfigSchema.parse({ title: 'Send a request' });
for (const width of [1280, 375])
  test(`recovers the exact public response after lost acknowledgement at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installEditorRoutes(page, remoteDraft());
    const path = `**/v1/forms/${publicId}`;
    await page.route(path, (route) =>
      route.fulfill({ json: { versionId, form } }),
    );
    const writes: { body: unknown; key: string | undefined }[] = [];
    await page.route(`${path}/submit`, async (route) => {
      writes.push({
        body: route.request().postDataJSON() as unknown,
        key: route.request().headers()['idempotency-key'],
      });
      expect(route.request().headers()['x-pertexo-form-key']).toBe(capability);
      if (writes.length === 1) return route.abort('failed');
      return route.fulfill({ json: { accepted: true, replayed: true } });
    });
    await page.goto(`/forms/${publicId}#${capability}`);
    await page
      .getByLabel('Message', { exact: true })
      .fill('Keep this exact response');
    await page
      .getByRole('button', { name: 'Send response', exact: true })
      .click();
    await expect(
      page.getByText(/We couldn’t confirm the result/u),
    ).toBeVisible();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
      'Keep this exact response',
    );
    await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
    await page
      .getByRole('button', { name: 'Retry same response', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Response sent', exact: true }),
    ).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.key).toBeTruthy();
    await expect(
      page.getByRole('link', { name: 'Open run', exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test('preserves typed fields when publication changes, and reloads only on request', async ({
  page,
  baseURL,
}) => {
  await installEditorRoutes(page, remoteDraft());
  await page.context().addCookies([
    {
      name: 'pertexo_csrf',
      value: 'csrf-form-browser-123456789012345678901234567890',
      url: baseURL ?? 'http://127.0.0.1:4173',
    },
  ]);
  const path = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/form`;
  let reads = 0;
  await page.route(path, (route) => {
    reads++;
    return route.fulfill({
      json: {
        versionId:
          reads === 1 ? versionId : '33333333-3333-4333-8333-333333333333',
        form: {
          ...form,
          title: reads === 1 ? 'Send a request' : 'Updated request',
        },
      },
    });
  });
  await page.route(`${path}/submit`, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/problem+json',
      json: {
        type: 'https://pertexo.test/problems/form.changed',
        title: 'Form changed',
        status: 409,
        code: 'form.changed',
        detail: 'The published form changed. Reload before sending.',
        requestId: 'form-conflict',
        instance: '/form/submit',
      },
    }),
  );
  await page.goto(`/w/${workspaceId}/forms/${workflowId}`);
  await page
    .getByLabel('Message', { exact: true })
    .fill('Keep until I choose to reload');
  await page
    .getByRole('button', { name: 'Send response', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Reload form', exact: true }),
  ).toBeVisible();
  expect(reads).toBe(1);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Keep until I choose to reload',
  );
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload form', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Updated request', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
});
