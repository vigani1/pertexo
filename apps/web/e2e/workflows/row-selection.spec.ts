import { expect, test, type Locator } from '../support/fixtures';
import { mappingGraph } from '../workflow-editor/graph';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  user,
  workflowSummary,
  workspace,
  workspaceId,
} from '../workflow-editor/support';

async function box(control: Locator) {
  const bounds = await control.boundingBox();
  if (bounds === null) throw new Error('The row control must be visible');
  return bounds;
}

for (const screen of [
  { width: 1280, touch: false },
  { width: 375, touch: false },
  { width: 375, touch: true },
]) {
  test(`keeps selection in the glyph column without growing rows at ${String(screen.width)}px${screen.touch ? ' touch' : ''}`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL ?? 'http://127.0.0.1:4173',
      viewport: { width: screen.width, height: 768 },
      hasTouch: screen.touch,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
      await addCsrfCookie(context);
      const remote = remoteDraft(mappingGraph());
      await installEditorRoutes(page, remote);
      const alpha = workflowSummary('Alpha').workflow;
      const beta = {
        ...workflowSummary('Beta').workflow,
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      };
      let editable = true;
      let tagged = false;
      let favoriteCalls = 0;
      await page.route(
        `**/v1/workspaces/${workspaceId}/workflows/${beta.id}/favorite`,
        (route) => {
          favoriteCalls += 1;
          return route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            json: {
              type: 'urn:pertexo:problem:internal.unexpected',
              title: 'Try again',
              status: 503,
              code: 'internal.unexpected',
              requestId: 'favorite-outage',
            },
          });
        },
      );
      await page.route('**/v1/workspaces?**', (route) =>
        route.fulfill({
          json: {
            items: [
              editable
                ? {
                    ...workspace,
                    capabilities: [
                      ...workspace.capabilities,
                      'workflow:create',
                    ],
                  }
                : {
                    ...workspace,
                    role: 'viewer',
                    capabilities: [
                      'workspace:read',
                      'workflow:read',
                      'run:read',
                    ],
                  },
            ],
            nextCursor: null,
          },
        }),
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/workflows?**`,
        (route) => {
          const organized =
            new URL(route.request().url()).searchParams.get('include') ===
            'organization';
          return route.fulfill({
            json: {
              items: [alpha, beta].map((workflow) =>
                organized
                  ? {
                      workflow,
                      organization: {
                        organizationRevision: 1,
                        folderId: null,
                        tags:
                          tagged && workflow.id === beta.id
                            ? [
                                {
                                  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                                  key: 'ops',
                                  revision: 1,
                                },
                              ]
                            : [],
                        isFavorite: false,
                      },
                    }
                  : workflow,
              ),
              nextCursor: null,
            },
          });
        },
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/workflows/${beta.id}/draft`,
        (route) =>
          route.fulfill({
            json: {
              workflowId: beta.id,
              revision: 1,
              graph: remote.graph,
              updatedAt: user.updatedAt,
              compatibility: {
                compatible: true,
                fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
                issues: [],
              },
            },
          }),
      );
      await page.goto(`/w/${workspaceId}/workflows`);
      const rows = page.getByRole('list', { name: 'Workflows', exact: true });
      const alphaTitle = rows.getByRole('link', { name: 'Alpha', exact: true });
      const alphaRow = rows.getByRole('listitem').filter({
        has: page.getByRole('link', { name: 'Alpha', exact: true }),
      });
      const betaRow = rows
        .getByRole('listitem')
        .filter({ has: page.getByRole('link', { name: 'Beta', exact: true }) });
      await expect(
        alphaRow.getByText('Manual input → Target', { exact: true }),
      ).toBeVisible();
      await expect(
        betaRow.getByText('Manual input → Target', { exact: true }),
      ).toBeVisible();
      const before = await box(alphaRow);
      const betaBefore = await box(betaRow);
      const selection = alphaRow.getByRole('checkbox', {
        name: 'Select Alpha',
        exact: true,
      });
      const betaSelection = betaRow.getByRole('checkbox', {
        name: 'Select Beta',
        exact: true,
      });
      const selectionBox = await box(selection);
      const titleBox = await box(alphaTitle);
      expect(selectionBox.x + selectionBox.width).toBeLessThan(titleBox.x);
      expect(selectionBox.y).toBeGreaterThanOrEqual(before.y);
      expect(selectionBox.y + selectionBox.height).toBeLessThanOrEqual(
        before.y + before.height,
      );
      await page.mouse.move(0, 0);
      await expect(selection).toHaveCSS('opacity', screen.touch ? '1' : '0');
      if (screen.touch) {
        // The box stays small; its hit area reaches past it.
        const hitArea = await selection.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const area = getComputedStyle(element, '::after');
          return {
            width: box.width - parseFloat(area.left) - parseFloat(area.right),
            height: box.height - parseFloat(area.top) - parseFloat(area.bottom),
          };
        });
        expect(hitArea.width).toBeGreaterThanOrEqual(44);
        expect(hitArea.height).toBeGreaterThanOrEqual(44);
      } else {
        await alphaRow.hover();
        await expect(selection).toHaveCSS('opacity', '1');
        await page.mouse.move(0, 0);
      }
      await selection.focus();
      await expect(selection).toHaveCSS('opacity', '1');
      await selection.press('Space');
      await expect(selection).toBeChecked();
      await expect(betaSelection).toHaveCSS('opacity', '1');
      expect((await box(alphaRow)).height).toBeCloseTo(before.height, 2);
      expect((await box(betaRow)).height).toBeCloseTo(betaBefore.height, 2);
      await page
        .getByRole('button', { name: 'Clear selection', exact: true })
        .click();
      expect((await box(alphaRow)).height).toBeCloseTo(before.height, 2);
      tagged = true;
      await page.reload();
      await expect(
        alphaRow.getByText('Manual input → Target', { exact: true }),
      ).toBeVisible();
      await expect(
        betaRow.getByText('Manual input → Target', { exact: true }),
      ).toBeVisible();
      await expect(betaRow.getByText('ops', { exact: true })).toBeVisible();
      expect((await box(alphaRow)).height).toBeCloseTo(before.height, 2);
      expect((await box(betaRow)).height).toBeGreaterThan(betaBefore.height);
      await testInfo.attach('selection and tagged rows', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await page.setViewportSize({ width: screen.width, height: 480 });
      await betaRow
        .getByRole('button', { name: 'Actions for Beta', exact: true })
        .click();
      const menu = page.getByRole('menu', {
        name: 'Actions for Beta',
        exact: true,
      });
      await expect(menu).toBeInViewport({ ratio: 1 });
      await menu
        .getByRole('menuitem', { name: 'Add favorite', exact: true })
        .click();
      await expect.poll(() => favoriteCalls).toBe(1);
      await expect(betaRow.getByRole('alert')).toHaveText('Favorite not saved');
      editable = false;
      tagged = false;
      await page.reload();
      await expect(
        alphaRow.getByText('Manual input → Target', { exact: true }),
      ).toBeVisible();
      await expect(selection).toHaveCount(0);
      expect((await box(alphaRow)).height).toBeCloseTo(before.height, 2);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(screen.width);
    } finally {
      await context.close();
    }
  });
}
