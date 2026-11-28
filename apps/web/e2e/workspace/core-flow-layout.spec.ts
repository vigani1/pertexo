import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  workspaceId,
} from '../workflow-editor/support';
import { mockIdentity } from './auth/fixture';
import { installAssistantProposal } from './core-flow-assistant-fixture';
import { triageGraph } from './core-flow-invoice-graph';
import { installEditorRoutes, remoteDraft } from '../workflow-editor/support';
import {
  approvalId,
  failedRunId,
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
  // Every read answered and drawn before the picture is taken.
  await page.waitForLoadState('networkidle');
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

test('the canvas lays AI steps and their categories in lanes', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockIdentity(page, { authenticated: false });
  await installCoreFlowRoutes(page, { graph: triageGraph() });
  await page.route('**/v1/workspaces/*/runs?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await addCsrfCookie(context);
  await page.goto(editorUrl);
  await page.getByRole('button', { name: 'Tidy lanes' }).click();
  await expect(
    page.getByText('Sort the ticket · bug', { exact: true }),
  ).toBeVisible();
  await shot(page, 'build-ai-steps', '1440x900-dark');
});

test('the phone canvas can tidy a connected workflow into lanes', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await addCsrfCookie(context);
  const draft = remoteDraft(triageGraph());
  await installEditorRoutes(page, draft);
  await page.goto(editorUrl);
  const before = draft.graph.nodes.map(({ position }) => position);
  await page.getByRole('button', { name: 'Tidy lanes', exact: true }).click();
  await expect
    .poll(() => draft.graph.nodes.map(({ position }) => position))
    .not.toEqual(before);
});

test('the tablet canvas can zoom with the step inspector open', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await addCsrfCookie(context);
  await installCoreFlowRoutes(page);
  await page.goto(editorUrl);
  const step = page.getByTestId('rf__node-intake');
  await step.focus();
  await step.press('Enter');
  await expect(
    page.getByRole('complementary', { name: 'Step panel' }),
  ).toBeVisible();
  const toolbar = page.getByRole('toolbar', { name: 'Canvas toolbar' });
  const zoom = toolbar.getByLabel('Zoom', { exact: true });
  const before = await zoom.innerText();
  await toolbar.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoom).not.toHaveText(before);
});
