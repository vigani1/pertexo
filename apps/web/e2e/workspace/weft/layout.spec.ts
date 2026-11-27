import { mkdir } from 'node:fs/promises';
import { test, expect } from '../../support/fixtures';
import { addCsrfCookie } from '../../workflow-editor/support';
import { mockIdentity } from '../auth/fixture';
import { installPublicScreenRoutes, installWorkspaceRoutes } from './fixture';
import { workspaceScreens } from './screens';

test.describe.configure({ mode: 'parallel' });

const viewports = [
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1280, 900],
  [1440, 900],
] as const;
// Set by hand to keep screenshots for comparing with the design boards.
const capture = process.env.PERTEXO_WEFT_SHOTS;

for (const [width, height] of viewports) {
  test.describe(`${String(width)}x${String(height)}`, () => {
    const touch = width <= 1024;
    test.use({ viewport: { width, height }, hasTouch: touch });

    for (const screen of workspaceScreens)
      for (const colorScheme of ['light', 'dark'] as const) {
        test(`${screen.name} fits in ${colorScheme}`, async ({
          page,
          context,
        }) => {
          await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
          await mockIdentity(page, { authenticated: false });
          if (screen.signedOut === true) await installPublicScreenRoutes(page);
          else {
            await installWorkspaceRoutes(page);
            await addCsrfCookie(context);
          }
          await page.goto(screen.path);
          await screen.open?.(page);
          await expect(screen.ready(page)).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          if (capture) {
            await mkdir(capture, { recursive: true });
            await page.screenshot({
              path: `${capture}/${screen.name}-${String(width)}-${colorScheme}.png`,
              fullPage: (await page.getByRole('dialog').count()) === 0,
            });
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
            `${screen.name} fits without horizontal page scroll`,
          ).toBeLessThanOrEqual(width);
          if (touch) {
            const targets = await page.evaluate(() =>
              [
                ...document.querySelectorAll(
                  '[data-slot="button"], [data-slot="tabs-trigger"], [data-slot="dropdown-menu-item"]',
                ),
              ]
                .filter(
                  (element) =>
                    !element.closest(
                      '[inert], [aria-hidden="true"], .react-flow__viewport',
                    ) &&
                    element.getClientRects().length > 0 &&
                    getComputedStyle(element).visibility === 'visible',
                )
                .flatMap((element) => {
                  const box = element.getBoundingClientRect();
                  return box.height >= 39.99 && box.width >= 39.99
                    ? []
                    : [
                        element.getAttribute('aria-label') ??
                          element.textContent.trim(),
                      ];
                }),
            );
            expect(targets, 'Shared touch controls have 40px targets').toEqual(
              [],
            );
          }
          if (screen.name === 'versions-detail') {
            const back = page.getByRole('button', {
              name: 'All versions',
              exact: true,
            });
            const list = page.getByRole('navigation', { name: 'Versions' });
            if (width < 900) {
              await expect(list).toBeHidden();
              await expect(back).toBeFocused();
              await back.click();
              await expect(list).toBeVisible();
              await expect(
                list.getByRole('button', { name: /^v2\b/u }),
              ).toBeFocused();
            } else {
              await expect(list).toBeVisible();
              await expect(back).toBeHidden();
            }
          }
          if (width < 600 && screen.name === 'create-workflow') {
            const drawer = await screen.ready(page).boundingBox();
            expect(drawer?.width).toBe(width);
          }
        });
      }
  });
}
