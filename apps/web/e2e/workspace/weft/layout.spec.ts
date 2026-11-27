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
// Set by hand to keep screenshots for comparing with the design boards.
const capture = process.env.PERTEXO_WEFT_SHOTS;

for (const screen of workspaceScreens)
  for (const [width, height] of viewports)
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`${screen.name} fits ${String(width)}x${String(height)} in ${colorScheme}`, async ({
        page,
        context,
      }) => {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        await mockIdentity(page, { authenticated: false });
        if (screen.signedOut !== true) {
          await installWorkspaceRoutes(page);
          await addCsrfCookie(context);
        }
        await page.goto(screen.path);
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
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${screen.name} has no horizontal page scroll`,
        ).toBe(true);
      });
    }
