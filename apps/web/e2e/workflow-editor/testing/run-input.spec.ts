import { expect, test } from '../../support/fixtures';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
} from '../support';

const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

for (const width of [1280, 768, 390]) {
  test(`keeps run confirmation visible while its inputs scroll at ${String(width)}×768`, async ({
    context,
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
    const remote = remoteDraft(mappingGraph());
    await installEditorRoutes(page, remote);
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
      (route) =>
        route.fulfill({ json: workflowSummary('Run input', versionId) }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
      (route) =>
        route.fulfill({
          json: {
            items: [
              {
                id: versionId,
                workflowId,
                versionNumber: 1,
                graph: remote.graph,
                checksum: `wf:sha256:${'a'.repeat(64)}`,
                publishedAt: '2026-10-01T12:00:00.000Z',
              },
            ],
            nextCursor: null,
          },
        }),
    );
    const attempts: { body: unknown; key: string | undefined }[] = [];
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
      async (route) => {
        attempts.push({
          body: route.request().postDataJSON() as unknown,
          key: route.request().headers()['idempotency-key'],
        });
        await route.abort('failed');
      },
    );
    await page.goto(editorUrl);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Run with input…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Run with input' });
    await expect(
      dialog.getByText('No input cases yet.', { exact: false }),
    ).toBeVisible();
    const start = dialog.getByRole('button', {
      name: 'Start published version',
      exact: true,
    });
    const initial = await start.boundingBox();
    expect(initial).not.toBeNull();
    expect((initial?.y ?? 0) + (initial?.height ?? 0)).toBeLessThanOrEqual(752);
    expect(initial?.y).toBeGreaterThan(0);
    const input = dialog.getByLabel('Run input (JSON)', { exact: true });
    expect(
      await input.evaluate((element) => {
        let parent = element.parentElement;
        while (parent !== null) {
          if (
            getComputedStyle(parent).overflowY === 'auto' &&
            parent.scrollHeight > parent.clientHeight
          )
            return true;
          parent = parent.parentElement;
        }
        return false;
      }),
    ).toBe(true);
    await input.fill('{');
    await start.click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused();
    expect(attempts).toEqual([]);
    await dialog
      .getByRole('button', { name: 'Pick a time', exact: true })
      .click();
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    const afterScroll = await start.boundingBox();
    expect(afterScroll?.y).toBe(initial?.y);
    await expect(cancel).toBeInViewport();
    await input.fill('{"customer":"Synthetic"}');
    await dialog.getByRole('button', { name: 'None', exact: true }).click();
    await start.click();
    const retry = dialog.getByRole('button', {
      name: 'Retry same run',
      exact: true,
    });
    await expect(retry).toBeEnabled();
    await expect(input).toBeDisabled();
    await expect(retry).toBeInViewport();
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]?.body).toMatchObject({
      input: { customer: 'Synthetic' },
      expectedPublishedVersionId: versionId,
    });
    const screenshot = testInfo.outputPath(`run-input-${String(width)}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach('Run input and exact retry', {
      path: screenshot,
      contentType: 'image/png',
    });
    await cancel.click();
    await expect(dialog).toBeHidden();
  });
}
