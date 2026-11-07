import type { ConnectionSharing, FolderSharing } from '@pertexo/contracts';
import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowId,
} from '../workflow-editor/support';

for (const width of [375, 1280])
  for (const kind of ['connection', 'folder'] as const) {
    test(`${kind} sharing keeps edits through a failed conflict read at ${String(width)}px`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
      await addCsrfCookie(context);
      await installEditorRoutes(page, remoteDraft(), {
        accessibleWorkspace: {
          ...workspace,
          capabilities: [...workspace.capabilities, 'connection:manage'],
        },
      });
      const base = `**/v1/workspaces/${workspaceId}`;
      const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const folder = {
        id: workflowId,
        name: 'Operations',
        parentId: null,
        revision: 1,
        depth: 1,
        accessMode: 'workspace',
      };
      const connection = {
        id: workflowId,
        workspaceId,
        providerKey: 'slack',
        name: 'Incident Slack',
        authType: 'slack_bot_token',
        status: 'active',
        secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        health: {
          lastTestedAt: null,
          lastHealthyAt: null,
          lastErrorCode: null,
        },
        createdAt: '2026-09-15T10:00:00Z',
        updatedAt: '2026-09-15T10:00:00Z',
      };
      await page.route(`${base}/workflow-folders`, (route) =>
        route.fulfill({ json: { items: [folder] } }),
      );
      await page.route(`${base}/connections?**`, (route) =>
        route.fulfill({ json: { items: [connection], nextCursor: null } }),
      );
      await page.route(`${base}/connections/${workflowId}`, (route) =>
        route.fulfill({ json: connection }),
      );
      await page.route(`${base}/connections/${workflowId}/usage?**`, (route) =>
        route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      await page.route(`${base}/resource-sharing-principals?**`, (route) =>
        route.fulfill({
          json: {
            items: [
              {
                kind: 'member',
                userId,
                label: 'Jane',
                email: 'jane@example.test',
                role: 'builder',
              },
            ],
            nextCursor: null,
          },
        }),
      );
      let current: ConnectionSharing | FolderSharing =
        kind === 'connection'
          ? {
              connectionId: workflowId,
              mode: 'workspace',
              revision: 1,
              members: [],
            }
          : {
              folderId: workflowId,
              mode: 'workspace',
              revision: 1,
              grants: [],
              labels: {},
            };
      let failedRead = false;
      const bodies: unknown[] = [];
      await page.route(
        `${base}/${kind === 'connection' ? 'connections' : 'workflow-folders'}/${workflowId}/sharing`,
        (route) => {
          if (route.request().method() === 'GET') {
            if (bodies.length === 1 && !failedRead) {
              failedRead = true;
              return route.fulfill({
                status: 503,
                contentType: 'application/problem+json',
                json: {
                  type: 'about:blank',
                  title: 'Unavailable',
                  status: 503,
                  code: 'internal.unexpected',
                  requestId: 'current-sharing-read-failed',
                },
              });
            }
            return route.fulfill({ json: current });
          }
          bodies.push(route.request().postDataJSON());
          if (bodies.length === 1) {
            current = { ...current, revision: 2 };
            return route.fulfill({
              status: 409,
              contentType: 'application/problem+json',
              json: {
                type: 'about:blank',
                title: 'Changed',
                status: 409,
                code:
                  kind === 'connection'
                    ? 'connection.conflict'
                    : 'workflow.folder_revision_conflict',
                requestId: 'sharing-refused',
              },
            });
          }
          current =
            kind === 'connection'
              ? {
                  connectionId: workflowId,
                  mode: 'restricted',
                  revision: 3,
                  members: [{ userId, label: 'Jane', active: true }],
                }
              : {
                  folderId: workflowId,
                  mode: 'restricted',
                  revision: 3,
                  grants: [{ kind: 'member', userId, access: 'viewer' }],
                  labels: { [userId]: 'Jane' },
                };
          return route.fulfill({ json: { ...current, replayed: false } });
        },
      );
      const path =
        kind === 'connection'
          ? `/w/${workspaceId}/connections?connection=${workflowId}`
          : `/w/${workspaceId}/workflows`;
      await page.goto(path);
      if (kind === 'connection')
        await page.getByRole('button', { name: 'Share', exact: true }).click();
      else {
        await page
          .getByRole('button', { name: 'Actions for Operations' })
          .click();
        await page
          .getByRole('menuitem', { name: 'Share…', exact: true })
          .click();
      }
      const dialog = page.getByRole('dialog', {
        name: kind === 'connection' ? 'Incident Slack' : 'Share Operations',
        exact: true,
      });
      await dialog.getByText('Only people you choose', { exact: true }).click();
      await dialog
        .getByRole('button', { name: 'Add Jane', exact: true })
        .click();
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        dialog.getByText('current-sharing-read-failed', { exact: true }),
      ).toBeVisible();
      const review = dialog.getByRole('button', {
        name: 'Keep edits and use latest revision',
      });
      await expect(review).toBeDisabled();
      await expect(
        dialog.getByRole('button', { name: 'Save', exact: true }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole('button', { name: 'Remove Jane' }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Discard edits and reload' }),
      ).toBeVisible();
      const retry = dialog.getByRole('button', { name: 'Retry', exact: true });
      await retry.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test
          .info()
          .outputPath(`${kind}-sharing-failed-read-${String(width)}.png`),
      });
      await retry.click();
      await expect(review).toBeEnabled();
      await expect(
        dialog.getByRole('button', { name: 'Remove Jane' }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Save', exact: true }),
      ).toBeDisabled();
      expect(bodies).toHaveLength(1);
      await expect(page).toHaveURL(path);
      await review.click();
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => bodies.length).toBe(2);
      expect(bodies[1]).toEqual(
        kind === 'connection'
          ? {
              mode: 'restricted',
              expectedSharingRevision: 2,
              userIds: [userId],
            }
          : {
              mode: 'restricted',
              expectedFolderRevision: 2,
              grants: [{ kind: 'member', userId, access: 'viewer' }],
            },
      );
    });
  }
