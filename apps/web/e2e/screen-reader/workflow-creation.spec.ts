import { workflowGraphReadBody } from '../workflows/read-projections';
import { expect, test } from '../support/fixtures';
import {
  expectFocusOn,
  expectSpoken,
  startScreenReader,
} from '../support/screen-reader';
import {
  csrfToken,
  mockIdentity,
  workspaceId,
} from '../workspace/auth/fixture';

const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

test('a screen-reader user creates a workflow from the keyboard and hears where they landed', async ({
  page,
}) => {
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
    ]);
  await mockIdentity(page, { authenticated: true });
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}**`,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/draft')) {
        await route.fulfill({
          headers: {
            'content-type': 'application/json',
            etag: `"draft.${'a'.repeat(43)}"`,
          },
          body: JSON.stringify(
            await workflowGraphReadBody(route.request().url(), {
              workflowId,
              revision: 1,
              graph: { nodes: [], edges: [], settings: {} },
              compatibility: {
                compatible: true,
                fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
                issues: [],
              },
              updatedAt: '2026-09-14T10:00:00.000Z',
            }),
          ),
        });
        return;
      }
      if (path.endsWith(workflowId)) {
        await route.fulfill({
          json: {
            workflow: {
              id: workflowId,
              workspaceId,
              name: 'Invoice intake',
              nameRevision: 1,
              lifecycleStatus: 'active',
              lifecycleRevision: 1,
              activationStatus: 'inactive',
              webhookSetupRequired: false,
              publishedVersionId: null,
              createdAt: '2026-09-14T10:00:00.000Z',
              updatedAt: '2026-09-14T10:00:00.000Z',
            },
          },
        });
        return;
      }
      await route.fulfill({ json: { items: [], nextCursor: null } });
    },
  );
  await page.goto(`/w/${workspaceId}/workflows`);
  const create = page.getByRole('button', { name: 'New workflow' });
  await expect(create).toBeVisible();
  await startScreenReader(page);

  await create.focus();
  await page.keyboard.press('Enter');
  // The sheet names itself and puts the user in its first field.
  await expectSpoken(page, /^dialog, New workflow, Start blank with a name/u);
  await expectFocusOn(page, 'textbox', 'Workflow name');
  await expectSpoken(page, /^textbox, Workflow name, For example/u);

  // Escape closes it and returns focus to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(create).toBeFocused();

  await page.keyboard.press('Enter');
  await expectFocusOn(page, 'textbox', 'Workflow name');
  await page.keyboard.type('Invoice intake');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows/${workflowId}`);
  await expectSpoken(page, /Workflow created/u);
  await expect(
    page.getByRole('heading', { name: 'Invoice intake' }),
  ).toBeVisible();
});
