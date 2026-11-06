import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowId,
} from '../workflow-editor/support';
const reviewId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const detail =
  'The draft changed after this request. Review the latest draft and request approval again.';
for (const width of [1280, 375]) {
  test(`refreshes a refused publication review at ${String(width)}px`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: {
        ...workspace,
        role: 'owner',
        capabilities: [...workspace.capabilities, 'workflow:publish'],
      },
    });
    let stale = false;
    const root = `**/v1/workspaces/${workspaceId}/publication-requests/${reviewId}`;
    await page.route(root, (route) =>
      route.fulfill({
        json: {
          request: {
            id: reviewId,
            workflowId,
            workflowName: 'Release',
            requestedBy: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            requesterName: 'Builder',
            draftRevision: 1,
            note: 'Release note',
            status: stale ? 'stale' : 'pending',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            decidedBy: null,
            deciderName: null,
            decidedAt: null,
            comment: null,
            publishedVersionId: null,
            versionNumber: null,
            canDecide: !stale,
          },
          graph: null,
          liveGraph: null,
        },
      }),
    );
    await page.route(`${root}/decision`, (route) => {
      stale = true;
      return route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        json: {
          type: 'urn:pertexo:problem:workflow.publication_review_conflict',
          title: 'Review changed',
          status: 409,
          code: 'workflow.publication_review_conflict',
          detail,
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      });
    });
    await page.goto(`/w/${workspaceId}/publish-reviews/${reviewId}`);
    await page.getByRole('button', { name: 'Approve and publish' }).click();
    await expect(page.getByText(detail, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Approve and publish' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Open workflow editor' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows/${workflowId}`);
    await page.getByText(detail, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath('publication-refusal.png'),
      fullPage: true,
    });
  });
}
