import { expect, test } from '@playwright/test';
import {
  nativeCallGraph,
  workflowCallPin,
} from '../test/support/workflow-call-fixtures';
import {
  callableVersionSource,
  versionSourceWorkflow,
} from '../test/support/workflow-version-source-fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
} from './workflow-editor-support';

for (const size of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`inspects and copies version source without changing a Call pin at ${size.name} width`, async ({
    context,
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const graph = nativeCallGraph();
    const remote = remoteDraft({ ...graph, settings: { ...graph.settings } });
    await addCsrfCookie(context);
    await installEditorRoutes(page, remote);
    let versionReads = 0;
    let draftWrites = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith('/draft'))
        draftWrites++;
    });
    await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
      route.fulfill({
        json: { items: [versionSourceWorkflow(workspaceId)], nextCursor: null },
      }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/*/versions?**`,
      async (route) => {
        expect(route.request().url()).toContain(
          `/workflows/${workflowCallPin.workflowId}/versions?`,
        );
        versionReads++;
        await route.fulfill({
          json: { items: [callableVersionSource], nextCursor: null },
        });
      },
    );
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-call').click();
    if (size.name === 'phone')
      await page.getByRole('button', { name: 'Step', exact: true }).click();
    expect(versionReads).toBe(0);
    await page
      .getByRole('button', { name: 'Browse version source', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Browse version source' });
    await expect(
      dialog.getByLabel('Workflow source', { exact: true }),
    ).toHaveText('Choose a workflow to inspect');
    await dialog.getByLabel('Workflow source', { exact: true }).click();
    await page
      .getByRole('option', {
        name: 'Reusable child source (active)',
        exact: true,
      })
      .click();
    await expect(
      dialog.getByLabel('Published version source', { exact: true }),
    ).toHaveText('Choose a version to inspect');
    await dialog
      .getByLabel('Published version source', { exact: true })
      .click();
    await page
      .getByRole('option', {
        name: `v2 — ${callableVersionSource.id}`,
        exact: true,
      })
      .click();
    await expect(
      dialog.getByText('Source only — eligibility unverified', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByLabel('Callable input declaration', { exact: true }),
    ).toContainText('name');
    await expect(
      dialog.getByLabel('Callable result declaration', { exact: true }),
    ).toContainText('answer');
    for (const [label, value] of [
      ['Copy source workflow ID', callableVersionSource.workflowId],
      ['Copy source version ID', callableVersionSource.id],
      ['Copy source version checksum', callableVersionSource.checksum],
    ] as const) {
      await dialog.getByRole('button', { name: label, exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(value);
    }
    await dialog
      .getByText('Source only — eligibility unverified', { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`version-source-${size.name}.png`),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await dialog.getByRole('button', { name: 'Close source browser' }).click();
    await expect(
      page.getByLabel('Pinned version ID', { exact: true }),
    ).toHaveValue(workflowCallPin.versionId);
    await expect(
      page.getByLabel('Callable contract identity', { exact: true }),
    ).toHaveValue(workflowCallPin.callableContractIdentity);
    expect(remote.graph).toEqual(graph);
    expect(draftWrites).toBe(0);
    expect(versionReads).toBe(1);
    await expect(page.getByRole('button', { name: /^Publish/u })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: /^Run/u })).toHaveCount(0);
  });
}
