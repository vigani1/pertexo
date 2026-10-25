import { expect, test, type Locator } from '../../support/fixtures';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  currentEtag,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspace,
  workspaceId,
} from '../support';

async function bounds(control: Locator) {
  const box = await control.boundingBox();
  if (box === null) throw new Error('Header controls must be visible');
  return box;
}

for (const screen of [
  { width: 320, touch: false },
  { width: 375, touch: false },
  { width: 375, touch: true },
]) {
  test(`shares one secondary menu and one command row at ${String(screen.width)}px${screen.touch ? ' touch' : ''}`, async ({
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
      await addCsrfCookie(context);
      const remote = remoteDraft(mappingGraph());
      await installEditorRoutes(page, remote, {
        definitions: [manualDefinition, definition],
        accessibleWorkspace: {
          ...workspace,
          capabilities: [...workspace.capabilities, 'workflow:create'],
        },
      });
      const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
      const version = {
        id: versionId,
        workflowId,
        versionNumber: 1,
        graph: remote.graph,
        checksum: `wf:sha256:${'a'.repeat(64)}`,
        publishedAt: '2026-09-14T10:00:00.000Z',
      };
      const compatibility = {
        compatible: true,
        fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
        issues: [],
      };
      await page.route(root, (route) =>
        route.fulfill({ json: workflowSummary('Order intake', versionId) }),
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
              matchesDraft: true,
            },
          },
          headers: { etag: currentEtag(remote) },
        }),
      );
      await page.goto(editorUrl);
      const header = page.locator('header');
      const more = header.getByRole('button', {
        name: 'More workflow actions',
        exact: true,
      });
      const run = header.getByRole('button', { name: 'Run', exact: true });
      const publish = header.getByRole('button', {
        name: 'No changes since v1',
        exact: true,
      });
      const issues = header.getByRole('button', {
        name: 'No issues',
        exact: true,
      });
      await expect(publish).toBeDisabled();
      await expect(
        issues.getByText('No issues', { exact: true }),
      ).toBeVisible();
      expect(
        await issues
          .getByText('No issues', { exact: true })
          .evaluate((label) => label.scrollWidth <= label.clientWidth),
      ).toBe(true);
      const boxes = await Promise.all([more, issues, run, publish].map(bounds));
      const baseline = boxes[0];
      if (baseline === undefined) throw new Error('Missing command row');
      for (const box of boxes) {
        expect(Math.abs(box.y - baseline.y)).toBeLessThan(1);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(screen.width);
      }
      expect((await bounds(header)).height).toBeLessThanOrEqual(220);
      for (const name of [
        'Export…',
        'Input cases',
        'Duplicate…',
        'Workflow contract',
      ])
        await expect(
          header.getByRole('button', { name, exact: true }),
        ).toHaveCount(0);
      for (const [action, title] of [
        ['Input cases', 'Input cases'],
        ['Duplicate…', 'Duplicate workflow'],
        ['Export…', 'Export workflow'],
        ['Workflow contract', 'Workflow contract'],
      ] as const) {
        await more.press('Enter');
        const menu = page.getByRole('menu', {
          name: 'More workflow actions',
          exact: true,
        });
        await expect(
          menu.getByRole('menuitem', { name: 'Export…', exact: true }),
        ).toBeVisible();
        await expect(
          menu.getByRole('menuitem', { name: 'Input cases', exact: true }),
        ).toBeVisible();
        await expect(
          menu.getByRole('menuitem', { name: 'Duplicate…', exact: true }),
        ).toBeVisible();
        await expect(
          menu.getByRole('menuitem', {
            name: 'Workflow contract',
            exact: true,
          }),
        ).toBeVisible();
        await menu
          .getByRole('menuitem', { name: action, exact: true })
          .press('Enter');
        const dialog = page.getByRole('dialog', { name: title, exact: true });
        await expect(dialog).toBeVisible();
        await expect(menu).not.toBeVisible();
        await expect(
          dialog.getByRole('heading', { name: title, exact: true, level: 2 }),
        ).toBeVisible();
        if (action === 'Duplicate…')
          await expect(
            dialog.getByRole('button', { name: 'Cancel', exact: true }),
          ).toBeEnabled();
        await dialog.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(more).toBeFocused();
      }
      await more.press('Enter');
      await page
        .getByRole('menuitem', { name: /^Keyboard shortcuts/ })
        .press('Enter');
      await expect(
        page.getByText('Show these shortcuts', { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(screen.width);
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true }),
      ).not.toBeVisible();
      await expect(more).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(screen.width);
      await page.screenshot({ path: testInfo.outputPath('phone-header.png') });
    } finally {
      await context.close();
    }
  });
}
