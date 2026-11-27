import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  workspaceId,
} from '../workflow-editor/support';
import { mockIdentity } from './auth/fixture';
import {
  approvalId,
  failedRunId,
  installAssistantProposal,
  installCoreFlowRoutes,
} from './core-flow-layout-fixture';

test.describe.configure({ mode: 'parallel' });

// The widths the core flow is designed for: phone, both tablet
// orientations, laptop and desktop.
const viewports = [
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1280, 900],
  [1440, 900],
] as const;
const capture = process.env.PERTEXO_CORE_FLOW_SHOTS;

async function shot(page: Page, name: string, size: string) {
  await page.locator('main').first().waitFor();
  await page.waitForTimeout(300);
  await page.evaluate(() => document.fonts.ready);
  if (capture) {
    await mkdir(capture, { recursive: true });
    await page.screenshot({
      path: `${capture}/${name}-${size}.png`,
      fullPage: true,
    });
  }
  expect
    .soft(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name} has no horizontal page scroll`,
    )
    .toBe(true);
  if (capture)
    await writeFile(
      `${capture}/${name}-${size}.json`,
      JSON.stringify(
        await page.evaluate(() =>
          [...document.querySelectorAll('main *')]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.width > 0 &&
                (rect.left < -1 || rect.right > innerWidth + 1) &&
                getComputedStyle(element).position !== 'absolute'
              );
            })
            .slice(0, 20)
            .map((element) => ({
              tag: element.tagName,
              text: element.textContent.slice(0, 80),
            })),
        ),
        null,
        2,
      ),
    );
}

for (const [width, height] of viewports)
  for (const colorScheme of ['dark', 'light'] as const) {
    const size = `${String(width)}x${String(height)}-${colorScheme}`;
    test(`core flow pages stay bounded at ${size}`, async ({
      page,
      context,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await mockIdentity(page, { authenticated: false });
      await installCoreFlowRoutes(page);
      await addCsrfCookie(context);
      const root = `/w/${workspaceId}`;
      const screens: readonly (readonly [string, string])[] = [
        ['home', root],
        ['workflows', `${root}/workflows`],
        ['runs', `${root}/runs`],
        ['run-failed', `${root}/runs/${failedRunId}`],
        ['inbox', `${root}/requests`],
        ['approval', `${root}/requests/${approvalId}`],
        ['build', editorUrl],
      ];
      for (const [name, path] of screens) {
        await page.goto(path);
        await shot(page, name, size);
      }
    });
  }

test('the canvas shows a live run as it happens', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockIdentity(page, { authenticated: false });
  await installCoreFlowRoutes(page, { live: true });
  await addCsrfCookie(context);
  await page.goto(editorUrl);
  await shot(page, 'build-live', '1440x900-dark');
});

for (const colorScheme of ['dark', 'light'] as const)
  test(`the assistant proposes beside the canvas in ${colorScheme}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await mockIdentity(page, { authenticated: false });
    await installCoreFlowRoutes(page);
    await installAssistantProposal(page);
    await addCsrfCookie(context);
    await page.goto(editorUrl);
    await page.getByRole('button', { name: 'Ask the assistant' }).click();
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    await panel
      .getByLabel('What should the workflow do?')
      .fill('If the receipt email fails, post it to #finance in Slack.');
    await panel.getByRole('button', { name: 'Send to model' }).click();
    await expect(
      panel.getByText('Post to #finance', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Workflow canvas' }),
    ).toBeVisible();
    await shot(page, 'build-assistant', `1440x900-${colorScheme}`);
  });
