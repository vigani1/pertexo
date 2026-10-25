import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  currentEtag,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
} from '../support';

for (const state of ['unchecked', 'valid', 'issues', 'unavailable'] as const) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`bounds the collaboration header in ${colorScheme} with ${state} validation`, async ({
      page,
      context,
    }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await addCsrfCookie(context);
      const remote = remoteDraft({
        nodes: [
          {
            id: 'manual',
            definition: manualDefinition.definition,
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            position: { x: 0, y: 0 },
            label: 'Shared input',
          },
        ],
        edges: [],
        settings: {},
      });
      await installEditorRoutes(page, remote, {
        definitions: [manualDefinition],
        workflowName: 'Our shared workflow',
      });
      await page.route('**/v1/workspaces/*/workflows/*/presence**', (route) =>
        route.request().method() === 'PUT'
          ? route.fulfill({ json: { accepted: true } })
          : route.fulfill({
              json: {
                people: [
                  {
                    userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    displayName: 'Discussion owner',
                    editing: true,
                    dirty: true,
                    baseRevision: 1,
                    tabCount: 1,
                  },
                ],
              },
            }),
      );
      await page.route('**/v1/workspaces/*/workflows/*/validate', (route) => {
        if (state === 'unavailable' || state === 'unchecked')
          return route.fulfill({
            status: 503,
            json: {
              code: 'internal.unexpected',
              title: 'Check unavailable',
              status: 503,
            },
          });
        return route.fulfill({
          headers: { etag: currentEtag(remote) },
          json: {
            valid: state === 'valid',
            currentPublication: null,
            issues:
              state === 'issues'
                ? Array.from({ length: 23 }, (_, index) => ({
                    code: 'invalid_config',
                    path: `$.nodes.manual.config.value${String(index)}`,
                    message: `Value ${String(index)} needs setup.`,
                  }))
                : [],
            compatibility: {
              compatible: true,
              fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
              issues: [],
            },
          },
        });
      });
      await page.goto(editorUrl);
      await expect(
        page.getByText('Unsaved changes in another tab.', { exact: true }),
      ).toBeVisible();
      const expectedLabel = {
        unchecked: 'Not checked yet',
        valid: 'No issues',
        issues: '23 issues',
        unavailable: 'Couldn’t check',
      }[state];
      if (state !== 'unchecked')
        await expect(page.locator('#editor-issues-chip')).toHaveText(
          expectedLabel,
        );
      for (const [width, height] of [
        [375, 800],
        [390, 844],
        [360, 740],
        [768, 1024],
        [1024, 768],
        [1440, 900],
        [1920, 1080],
      ] as const) {
        await page.setViewportSize({ width: width, height: height });

        await page.screenshot({
          path: `${process.env.PERTEXO_EDITOR_HEADER_SHOTS ?? '/tmp/pertexo-editor-header'}/${String(width)}-${colorScheme}-${state}.png`,
        });
        expect(
          (await page.locator('header').boundingBox())?.height,
        ).toBeLessThanOrEqual(190);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        const chip = page.locator('#editor-issues-chip');
        await chip.focus();
        await expect(chip).toBeFocused();
        await expect(chip).toHaveAttribute('title', /.+/u);
        await chip.click();
        await expect(
          page.getByRole('region', {
            name: state === 'issues' ? '23 issues' : 'Issues',
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole('button', { name: 'Close issues', exact: true })
          .click();
        await expect(chip).toBeFocused();
      }
    });
  }
}
