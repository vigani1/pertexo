import { workflowVersionsBody } from '../../workflows/read-projections';
import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowId,
  workflowSummary,
  user,
} from '../support';

for (const width of [375, 1280]) {
  test(`refreshes recently viewed versions after approval at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await addCsrfCookie(context);
    const graph = { nodes: [], edges: [], settings: {} };
    await installEditorRoutes(page, remoteDraft(graph));
    const reviewId = '99999999-9999-4999-8999-999999999999';
    const firstId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const secondId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    let published = false;
    let versionReads = 0;
    const request = () => ({
      id: reviewId,
      workflowId,
      workflowName: 'Release',
      requestedBy: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      requesterName: 'Builder',
      draftRevision: 1,
      note: '',
      status: published ? 'approved' : 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      decidedBy: published ? user.id : null,
      deciderName: published ? 'Reviewer' : null,
      decidedAt: published ? new Date().toISOString() : null,
      comment: null,
      publishedVersionId: published ? secondId : null,
      versionNumber: published ? 2 : null,
      canDecide: !published,
    });
    await page.route(
      `**/v1/workspaces/${workspaceId}/publication-requests/${reviewId}`,
      (route) =>
        route.fulfill({
          json: { request: request(), graph: null, liveGraph: null },
        }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/publication-requests/${reviewId}/decision`,
      (route) => {
        published = true;
        return route.fulfill({ json: request() });
      },
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
      (route) =>
        route.fulfill({
          json: workflowSummary('Release', published ? secondId : firstId),
        }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
      async (route) => {
        versionReads += 1;
        const version = (id: string, versionNumber: number) => ({
          id,
          workflowId,
          versionNumber,
          graph,
          checksum: `wf:sha256:${'b'.repeat(64)}`,
          publishedAt: '2026-09-14T10:00:00.000Z',
        });
        return route.fulfill({
          json: await workflowVersionsBody(route.request().url(), {
            items: published
              ? [version(secondId, 2), version(firstId, 1)]
              : [version(firstId, 1)],
            nextCursor: null,
          }),
        });
      },
    );
    await page.goto(`/w/${workspaceId}/publish-reviews/${reviewId}`);
    await page.getByRole('link', { name: 'Open workflow editor' }).click();
    await page.getByRole('link', { name: 'Versions', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Preview v1', exact: true }),
    ).toBeVisible();
    const before = versionReads;
    await page.goBack();
    await page.goBack();
    await page.getByRole('button', { name: 'Approve and publish' }).click();
    await expect(
      page.getByText('Published v2. This decision is complete.'),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Open workflow editor' }).click();
    await page.getByRole('link', { name: 'Versions', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Preview v2', exact: true }),
    ).toBeVisible();
    expect(versionReads).toBeGreaterThan(before);
    await expect(page).toHaveURL(
      `/w/${workspaceId}/workflows/${workflowId}/versions`,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
