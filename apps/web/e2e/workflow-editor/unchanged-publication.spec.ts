import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  currentEtag,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
} from './support';

const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const graph = {
  nodes: [
    {
      id: 'set',
      definition: { key: 'core.set', version: 1 },
      position: { x: 80, y: 120 },
      configVersion: 1,
      config: { value: 'hello' },
      inputMappings: {},
      connectionRefs: {},
    },
  ],
  edges: [],
  settings: {},
};
const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
  issues: [],
};
const version = {
  id: versionId,
  workflowId,
  versionNumber: 1,
  graph,
  checksum: `wf:sha256:${'a'.repeat(64)}`,
  publishedAt: '2026-09-14T10:00:00.000Z',
};
const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;

for (const width of [390, 1280]) {
  test(`explains an unchanged live draft and allows unsaved editing at ${String(width)}px`, async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    const remote = remoteDraft(graph);
    await addCsrfCookie(context);
    await installEditorRoutes(page, remote);
    await page.route(root, (route) =>
      route.fulfill({
        json: workflowSummary('Order intake', versionId),
      }),
    );
    await page.route(`${root}/versions?**`, (route) =>
      route.fulfill({ json: { items: [version], nextCursor: null } }),
    );
    await page.route(`${root}/validate`, (route) =>
      route.fulfill({
        json: {
          valid: true,
          issues: [],
          compatibility,
          currentPublication: {
            versionId,
            versionNumber: 1,
            matchesDraft: remote.revision === 1,
          },
        },
        headers: { etag: currentEtag(remote) },
      }),
    );
    let publishes = 0;
    await page.route(`${root}/publish`, (route) => {
      publishes += 1;
      return route.fulfill({ json: { version, reused: true } });
    });
    await page.goto(editorUrl);
    const unchanged = page.getByRole('button', { name: 'No changes since v1' });
    await expect(unchanged).toBeDisabled();
    await page.screenshot({
      path: `/tmp/pertexo-polish-5-${String(width)}.png`,
      fullPage: false,
    });
    await unchanged.press('Enter');
    await expect(page.getByRole('dialog', { name: /Publish/u })).toHaveCount(0);
    expect(publishes).toBe(0);
    await page.locator('.react-flow__node').click();
    if (width < 640)
      await page.getByRole('button', { name: 'Step', exact: true }).click();
    await page.getByLabel('Value', { exact: true }).fill('changed');
    if (width < 640)
      await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Publish v2' }),
    ).toBeEnabled();
  });
}

test('reports checksum reuse without pretending a new version was created', async ({
  context,
  page,
}) => {
  const remote = remoteDraft(graph);
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.route(root, (route) =>
    route.fulfill({
      json: workflowSummary('Order intake', versionId),
    }),
  );
  await page.route(`${root}/versions?**`, (route) =>
    route.fulfill({ json: { items: [version], nextCursor: null } }),
  );
  await page.route(`${root}/publish`, (route) =>
    route.fulfill({ json: { version, reused: true } }),
  );
  await page.goto(editorUrl);
  await page.getByRole('button', { name: 'Publish v2' }).click();
  await page
    .getByRole('dialog', { name: 'Publish v2' })
    .getByRole('button', { name: 'Publish v2' })
    .click();
  await expect(page.getByText('v1 is still live')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'No changes since v1' }),
  ).toBeDisabled();
  await expect(page.getByText('v2 is live')).toHaveCount(0);
});
