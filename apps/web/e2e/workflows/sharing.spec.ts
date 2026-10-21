import {
  folderSharingRequestSchema,
  connectionSharingRequestSchema,
} from '@pertexo/contracts';
import { expect, test, type Page } from '../support/fixtures';
import type { TestInfo } from '@playwright/test';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  mappingGraph,
  manualDefinition,
  definition,
  workflowSummary,
  workspace,
  workspaceId,
  workflowId,
  editorUrl,
  user,
} from '../workflow-editor/support';
const parentId = '11111111-1111-4111-8111-111111111111';
const folderId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';
const token = 'b'.repeat(64);
for (const theme of ['light', 'dark'] as const)
  for (const width of [1280, 990, 375]) {
    test(`shares resources and reviews audience changes at ${String(width)}px in ${theme}`, async ({
      page,
      context,
    }, info) => {
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.route('**/v1/**', (route) =>
        route.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          json: {
            type: 'urn:pertexo:problem:resource.not_found',
            title: 'Not found',
            status: 404,
            code: 'resource.not_found',
            requestId: 'synthetic-sharing-read',
          },
        }),
      );
      await addCsrfCookie(context);
      await installEditorRoutes(page, remoteDraft(mappingGraph()), {
        definitions: [manualDefinition, definition],
        accessibleWorkspace: {
          ...workspace,
          capabilities: [
            ...workspace.capabilities,
            'connection:manage',
            'connection:use',
          ],
        },
      });
      const base = `**/v1/workspaces/${workspaceId}`;
      const folders = [
        {
          id: parentId,
          name: 'Restricted Operations',
          parentId: null as string | null,
          revision: 1,
          depth: 1,
          canCreateWorkflows: true,
        },
        {
          id: folderId,
          name: 'Finance',
          parentId,
          revision: 1,
          depth: 2,
          canCreateWorkflows: true,
        },
      ];
      let sharing = {
        folderId,
        revision: 1,
        mode: 'restricted' as 'restricted' | 'workspace',
        grants: [
          {
            kind: 'member' as const,
            userId: memberId,
            access: 'editor' as 'editor' | 'viewer',
          },
        ],
        labels: { [memberId]: 'Finance reviewer' },
      };
      let connectionSharing = {
        connectionId,
        revision: 1,
        mode: 'restricted' as 'restricted' | 'workspace',
        members: [
          { userId: memberId, label: 'Finance reviewer', active: true },
        ],
      };
      let moves = 0,
        shares = 0,
        connectionShares = 0;
      await page.route(`${base}/workflow-folders`, (route) =>
        route.fulfill({ json: { items: folders } }),
      );
      await page.route(
        `${base}/workflow-folders/${folderId}/sharing`,
        async (route) => {
          if (route.request().method() === 'GET')
            return route.fulfill({ json: sharing });
          const body = folderSharingRequestSchema.parse(
            route.request().postDataJSON(),
          );
          expect(body.expectedFolderRevision).toBe(sharing.revision);
          shares++;
          sharing = {
            ...sharing,
            mode: body.mode,
            grants: body.grants.filter((grant) => grant.kind === 'member'),
            revision: sharing.revision + 1,
          };
          const folder = folders.find((folder) => folder.id === folderId);
          if (folder) folder.revision = sharing.revision;
          return route.fulfill({ json: { ...sharing, replayed: false } });
        },
      );
      await page.route(`${base}/resource-sharing-principals?**`, (route) =>
        route.fulfill({
          json: {
            items: [
              { kind: 'member', userId: memberId, label: 'Finance reviewer' },
              { kind: 'member', userId: user.id, label: 'Operations owner' },
            ],
            next: null,
          },
        }),
      );
      await page.route(`${base}/workflow-folders/review-move`, (route) =>
        route.fulfill({
          json: {
            items: [
              {
                id: folderId,
                requiresReview: true,
                token,
                removedRestrictions: [
                  { id: parentId, name: 'Restricted Operations' },
                ],
              },
            ],
          },
        }),
      );
      await page.route(
        `${base}/workflow-folders/${folderId}/move`,
        async (route) => {
          expect(route.request().postDataJSON()).toMatchObject({
            parentId: null,
            expectedFolderRevision: 2,
            audienceReview: { token, acknowledge: true },
          });
          moves++;
          const folder = folders.find((folder) => folder.id === folderId);
          if (!folder) throw new Error('Folder missing');
          folder.parentId = null;
          folder.depth = 1;
          folder.revision++;
          await route.fulfill({ json: { folder, replayed: false } });
        },
      );
      await page.goto(`/w/${workspaceId}/workflows`);
      await page.getByRole('button', { name: /^Filters/u }).click();
      await page
        .getByRole('button', { name: 'Manage folders and tags…' })
        .click();
      const manager = page.getByRole('dialog', {
        name: 'Manage workflow organization',
      });
      await manager
        .getByRole('button', { name: 'Edit folder Finance', exact: true })
        .click();
      await manager
        .getByRole('button', { name: 'Sharing', exact: true })
        .click();
      const sharingForm = manager.getByRole('region', {
        name: 'Sharing for Finance',
      });
      await expect(
        sharingForm.getByRole('button', { name: 'Remove Finance reviewer' }),
      ).toBeVisible();
      await sharingForm
        .getByRole('combobox', { name: 'Access for Finance reviewer' })
        .focus();
      await page.keyboard.press('ArrowDown');
      await page.getByRole('option', { name: 'Viewer', exact: true }).click();
      await capture(page, info, `folder-sharing-${theme}-${String(width)}`);
      await sharingForm
        .getByRole('button', { name: 'Save sharing', exact: true })
        .press('Enter');
      await expect.poll(() => shares).toBe(1);
      await expect(
        manager.getByRole('button', { name: 'Move folder', exact: true }),
      ).toBeEnabled();
      await manager.getByRole('combobox', { name: 'Parent folder' }).click();
      await page
        .getByRole('option', { name: 'Unfiled / top level', exact: true })
        .click();
      await manager
        .getByRole('button', { name: 'Move folder', exact: true })
        .click();
      const review = manager.getByRole('region', {
        name: 'Review audience change',
      });
      const approve = review.getByRole('button', {
        name: 'Confirm move and audience change',
      });
      await expect(approve).toBeDisabled();
      expect(moves).toBe(0);
      await review.getByRole('checkbox').check();
      await capture(page, info, `audience-review-${theme}-${String(width)}`);
      await approve.press('Enter');
      await expect.poll(() => moves).toBe(1);
      await manager.getByRole('button', { name: 'Close manager' }).click();
      const connection = {
        id: connectionId,
        workspaceId,
        providerKey: 'http',
        name: 'Billing API',
        authType: 'http_headers',
        status: 'active',
        secretVersionId: parentId,
        health: {
          lastTestedAt: null,
          lastHealthyAt: null,
          lastErrorCode: null,
        },
        createdAt: '2026-10-21T10:00:00.000Z',
        updatedAt: '2026-10-21T10:00:00.000Z',
      };
      await page.route(`${base}/connections?**`, (route) =>
        route.fulfill({ json: { items: [connection], nextCursor: null } }),
      );
      await page.route(`${base}/connections/${connectionId}`, (route) =>
        route.fulfill({ json: connection }),
      );
      await page.route(
        `${base}/connections/${connectionId}/usage?**`,
        (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
      );
      await page.route(
        `${base}/connections/${connectionId}/sharing`,
        async (route) => {
          if (route.request().method() === 'GET')
            return route.fulfill({ json: connectionSharing });
          const body = connectionSharingRequestSchema.parse(
            route.request().postDataJSON(),
          );
          expect(body.expectedSharingRevision).toBe(1);
          connectionShares++;
          connectionSharing = {
            ...connectionSharing,
            mode: body.mode,
            revision: 2,
          };
          await route.fulfill({
            json: { ...connectionSharing, replayed: false },
          });
        },
      );
      await page.goto(
        `/w/${workspaceId}/connections?connection=${connectionId}`,
      );
      const details = page.getByRole('dialog', {
        name: 'Billing API',
        exact: true,
      });
      await details
        .getByRole('button', { name: 'Sharing', exact: true })
        .click();
      await expect(
        details.getByText('Who can use this connection?'),
      ).toBeVisible();
      await expect(
        details.getByRole('button', { name: 'Add Operations owner' }),
      ).toBeVisible();
      await capture(page, info, `connection-sharing-${theme}-${String(width)}`);
      await details
        .getByRole('button', { name: 'Save sharing', exact: true })
        .press('Enter');
      await expect.poll(() => connectionShares).toBe(1);
      await expect(
        details.getByRole('button', { name: 'Back to details' }),
      ).toBeEnabled();
      await page.route(`${base}/workflows/${workflowId}`, (route) =>
        route.fulfill({
          json: {
            workflow: {
              ...workflowSummary('Finance workflow').workflow,
              resourceAccess: { canEdit: false, canPublish: false },
            },
          },
        }),
      );
      await page.goto(editorUrl);
      await expect(
        page.getByText('View-only access.', { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Add note', exact: true }),
      ).toHaveCount(0);
      await capture(page, info, `view-only-editor-${theme}-${String(width)}`);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });
  }

async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}
