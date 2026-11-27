import { mkdir } from 'node:fs/promises';
import { test, expect } from '../../support/fixtures';
import { addCsrfCookie } from '../../workflow-editor/support';
import { mockIdentity } from '../auth/fixture';
import { installWorkspaceRoutes, workspaceScreens } from './fixture';

test.describe.configure({ mode: 'parallel' });

const viewports = [
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1280, 900],
  [1440, 900],
] as const;
const capture = process.env.PERTEXO_WEFT_SHOTS;
const only = process.env.PERTEXO_WEFT_ONLY?.split(',');

for (const [width, height] of viewports)
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`workspace pages fit ${String(width)}x${String(height)} in ${colorScheme}`, async ({
      page,
      context,
    }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await mockIdentity(page, { authenticated: false });
      if (process.env.PERTEXO_WEFT_MISSING)
        page.on('response', (response) => {
          if (response.status() === 404 && response.url().includes('/v1/'))
            console.log(`missing ${response.url()}`);
        });
      await installWorkspaceRoutes(page);
      await addCsrfCookie(context);
      for (const screen of workspaceScreens) {
        if (only !== undefined && !only.includes(screen.name)) continue;
        await page.goto(screen.path);
        await page.locator('main').first().waitFor();
        await page
          .waitForLoadState('networkidle', { timeout: 5_000 })
          .catch(() => undefined);
        await screen.ready?.(page);
        // Skeletons fade in after 150 ms; let any left settle.
        await page.waitForTimeout(400);
        await page.evaluate(() => document.fonts.ready);
        if (capture) {
          await mkdir(capture, { recursive: true });
          await page.screenshot({
            path: `${capture}/${screen.name}-${String(width)}-${colorScheme}.png`,
            fullPage: (await page.getByRole('dialog').count()) === 0,
          });
        }
        expect
          .soft(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            `${screen.name} has no horizontal page scroll`,
          )
          .toBe(true);
      }
    });
  }
