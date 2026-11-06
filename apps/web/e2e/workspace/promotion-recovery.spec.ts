import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowId,
} from '../workflow-editor/support';

const versionId = '22222222-2222-4222-8222-222222222222';
const targetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const graph = { nodes: [], edges: [], settings: {} };
const refusals = {
  stale:
    'The source, target or its setup changed. Review this promotion again.',
  target:
    'A target workflow was edited directly. Review and explicitly acknowledge replacing its changes.',
  requirements:
    'Resolve the missing or incompatible requirements before promoting.',
};
for (const width of [1280, 375]) {
  for (const kind of ['stale', 'target', 'requirements'] as const) {
    test(`recovers ${kind} promotion reviews at ${String(width)}px`, async ({
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
          capabilities: [
            ...workspace.capabilities,
            'workflow:update',
            'workflow:publish',
          ],
        },
      });
      const root = `**/v1/workspaces/${workspaceId}/promotions`;
      await page.route(`${root}/settings`, (route) =>
        route.fulfill({
          json: {
            revision: 1,
            canConfigure: false,
            target: {
              status: 'available',
              workspaceId: targetId,
              name: 'Production',
              requireApproval: false,
            },
          },
        }),
      );
      await page.route(`${root}/candidates?*`, (route) =>
        route.fulfill({
          json: { items: [], nextCursor: null, nextVersionNumber: null },
        }),
      );
      await page.route(`${root}/history?*`, (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      let reviews = 0;
      await page.route(`${root}/preview`, (route) => {
        reviews += 1;
        const renewed = reviews > 1;
        return route.fulfill({
          json: {
            fingerprint: (renewed ? 'b' : 'a').repeat(64),
            sourceWorkspaceId: workspaceId,
            sourceWorkspaceName: 'Development',
            targetWorkspaceId: targetId,
            targetWorkspaceName: 'Production',
            mode: 'draft',
            requireApproval: false,
            compatible: !(renewed && kind === 'requirements'),
            workflows: [
              {
                sourceWorkflowId: workflowId,
                sourceName: 'Release',
                sourceVersionId: versionId,
                sourceVersionNumber: 1,
                sourceChecksum: `wf:sha256:${'a'.repeat(64)}`,
                targetWorkflowId: '99999999-9999-4999-8999-999999999999',
                targetName: 'Release',
                targetRevision: 2,
                targetPublishedVersionId: null,
                directChanges: renewed && kind === 'target',
                proposedGraph: graph,
                targetGraph: graph,
              },
            ],
            requirements:
              renewed && kind === 'requirements'
                ? [
                    {
                      workflowId,
                      kind: 'variable',
                      name: 'TOKEN',
                      status: 'missing',
                      detail:
                        'Set TOKEN in the target workspace before reviewing again.',
                    },
                  ]
                : [],
          },
        });
      });
      await page.route(`${root}/apply`, (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'urn:pertexo:problem:workflow.promotion_conflict',
            title: 'Promotion changed',
            status: 409,
            code: 'workflow.promotion_conflict',
            detail: refusals[kind],
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        }),
      );
      await page.goto(
        `/w/${workspaceId}/settings/promotion?selected=${workflowId}:${versionId}`,
      );
      await page
        .getByRole('button', { name: 'Review promotion', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Create target drafts', exact: true })
        .click();
      const failure = page.getByText(refusals[kind], { exact: true });
      await expect(failure).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Create target drafts', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('link', { name: 'Open target workspace' }),
      ).toHaveAttribute('href', `/w/${targetId}`);
      await failure.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath('promotion-refusal.png'),
        fullPage: true,
      });
      await page
        .getByRole('button', { name: 'Review again', exact: true })
        .click();
      const apply = page.getByRole('button', {
        name: 'Create target drafts',
        exact: true,
      });
      if (kind === 'target') {
        await expect(
          page.getByRole('checkbox', { name: 'Replace these target changes' }),
        ).not.toBeChecked();
        await expect(apply).toBeDisabled();
      } else if (kind === 'requirements') {
        await expect(
          page.getByText(
            'Set TOKEN in the target workspace before reviewing again.',
          ),
        ).toBeVisible();
        await expect(apply).toBeDisabled();
      } else await expect(apply).toBeEnabled();
      await page.screenshot({
        path: info.outputPath('promotion-refreshed.png'),
        fullPage: true,
      });
    });
  }
}
