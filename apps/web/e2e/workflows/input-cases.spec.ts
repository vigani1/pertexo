import { expect, test } from '@playwright/test';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
} from '../workflow-editor/support';

test.use({ hasTouch: true });

test('keeps long input-case names bounded and case recovery keyboard accessible on mobile', async ({
  context,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await addCsrfCookie(context);
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installEditorRoutes(page, remoteDraft());
  const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const caseId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const longName = 'Synthetic'.repeat(14);
  const metadata = {
    id: caseId,
    workspaceId,
    workflowId,
    workflowVersionId: versionId,
    versionChecksum: `wf:sha256:${'a'.repeat(64)}`,
    name: longName,
    revision: 1,
    representationTag: `"wic1.${caseId.replaceAll('-', '')}.1"`,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  };
  const input = { customer: { name: 'Synthetic customer' } };
  const endpoint = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/input-cases`;
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      route.fulfill({ json: workflowSummary('Case workflow', versionId) }),
  );
  await page.route(`${endpoint}?**`, (route) =>
    route.fulfill({ json: { items: [metadata] } }),
  );
  const writes: {
    body: unknown;
    tag: string | undefined;
    key: string | undefined;
  }[] = [];
  await page.route(`${endpoint}/${caseId}`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: { case: { ...metadata, input } },
        headers: { ETag: metadata.representationTag },
      });
      return;
    }
    writes.push({
      body: route.request().postDataJSON() as unknown,
      tag: route.request().headers()['if-match'],
      key: route.request().headers()['idempotency-key'],
    });
    if (writes.length === 1) await route.abort('failed');
    else await route.fulfill({ json: { caseId, revision: 2, replayed: true } });
  });
  await page.goto(editorUrl);
  await page.waitForLoadState('networkidle');
  const action = page.getByRole('button', { name: 'Input cases', exact: true });
  await action.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Input cases', exact: true });
  const load = dialog.getByRole('button', {
    name: `Load ${longName}`,
    exact: true,
  });
  await load.focus();
  await page.keyboard.press('Enter');
  const copy = dialog.getByLabel(`Loaded input: ${longName}`, { exact: true });
  await expect(copy).toHaveValue(JSON.stringify(input, null, 2));
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  const mobileScreenshot = testInfo.outputPath('long-case-mobile.png');
  await page.screenshot({ path: mobileScreenshot });
  await testInfo.attach('long-case-mobile', {
    path: mobileScreenshot,
    contentType: 'image/png',
  });
  await dialog
    .getByRole('button', { name: `Edit ${longName}`, exact: true })
    .focus();
  await page.keyboard.press('Enter');
  const caseInput = dialog.getByLabel('Case input (JSON)', { exact: true });
  await expect(caseInput).toBeEnabled();
  await caseInput.fill('{');
  await dialog
    .getByRole('button', { name: 'Save input case', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(caseInput).toHaveAttribute('aria-invalid', 'true');
  await expect(caseInput).toBeFocused();
  expect(writes).toEqual([]);
  await caseInput.fill('{"customer":"updated"}');
  await dialog
    .getByRole('button', { name: 'Save input case', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  const retry = dialog.getByRole('button', {
    name: 'Retry exact case change',
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await expect(caseInput).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Close input cases' }),
  ).toBeDisabled();
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(caseInput).not.toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]?.tag).toBe(metadata.representationTag);
  await expect(copy).toHaveValue(JSON.stringify(input, null, 2));
  await dialog.getByRole('button', { name: 'Close input cases' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(action).toBeFocused();
});
