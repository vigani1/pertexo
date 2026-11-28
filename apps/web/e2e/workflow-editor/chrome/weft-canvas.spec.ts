import { mkdir } from 'node:fs/promises';
import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import { expect, test, type Page } from '../../support/fixtures';
import { installAssistantProposal } from '../../workspace/core-flow-assistant-fixture';
import { installAgentRun, task } from './weft-agent-fixture';
import { installCoreFlowRoutes } from '../../workspace/core-flow-layout-fixture';
import { addCsrfCookie, editorUrl } from '../support';

const screenshots = process.env.PERTEXO_CANVAS_SHOTS;
const viewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 900 },
  { width: 1440, height: 900 },
];

async function checkCanvas(page: Page, board: string, theme: string) {
  const canvas = page.getByRole('region', { name: 'Workflow canvas' });
  await expect(canvas).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  if (screenshots === undefined) return;
  await mkdir(screenshots, { recursive: true });
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${screenshots}/${board}-${String(page.viewportSize()?.width)}-${theme}.png`,
    fullPage: true,
  });
}

for (const viewport of screenshots === undefined
  ? [viewports[0], viewports[2], viewports[4]]
  : viewports) {
  if (viewport === undefined) continue;
  for (const theme of screenshots === undefined
    ? (['dark'] as const)
    : (['dark', 'light'] as const)) {
    test.describe(`Weft Build at ${String(viewport.width)}px in ${theme}`, () => {
      test.beforeEach(async ({ page, context }) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });
        await addCsrfCookie(context);
      });

      test('keeps the canvas and selected step accessible', async ({
        page,
      }) => {
        await installCoreFlowRoutes(page);
        await page.goto(editorUrl);
        await expect(page.getByTestId('rf__node-intake')).toBeInViewport();
        await checkCanvas(page, 'build', theme);
        const step = page.getByTestId('rf__node-over');
        await step.press('Enter');
        if (viewport.width < 1024) {
          await page.getByRole('button', { name: 'Step', exact: true }).click();
        }
        const inspector = page.getByRole('complementary', {
          name: 'Step panel',
        });
        await expect(
          inspector.getByRole('textbox', { name: 'Label', exact: true }),
        ).toHaveValue('Over 5,000?');
        await expect(step).toBeInViewport();
        await checkCanvas(page, 'build-step', theme);
      });

      test('shows the current step and its actual run order', async ({
        page,
      }) => {
        await installCoreFlowRoutes(page, { live: true });
        await page.goto(editorUrl);
        await expect(page.getByText('Now at Post to ERP')).toBeVisible();
        await expect(page.getByText('Step 4', { exact: true })).toBeVisible();
        await expect(page.getByText(/Live run started/u)).toBeVisible();
        if (viewport.width === 1024) {
          const receipt = page.getByTestId('rf__node-receipt');
          await expect
            .poll(() =>
              receipt.evaluate((node) => {
                const frame = node
                  .closest('[data-workflow-canvas]')
                  ?.getBoundingClientRect();
                if (frame === undefined) return false;
                const rect = node.getBoundingClientRect();
                return (
                  rect.left >= frame.left &&
                  rect.right <= frame.right &&
                  rect.top >= frame.top &&
                  rect.bottom <= frame.bottom
                );
              }),
            )
            .toBe(true);
        }
        await checkCanvas(page, 'build-live', theme);
      });

      test('draws the assistant proposal and clears it on discard', async ({
        page,
      }) => {
        await installCoreFlowRoutes(page);
        await installAssistantProposal(page);
        await page.goto(editorUrl);
        await page.getByRole('button', { name: 'Ask the assistant' }).click();
        const panel = page.getByRole('complementary', { name: 'Assistant' });
        await panel
          .getByLabel('What should the workflow do?')
          .fill('If the receipt email fails, post a Slack message.');
        await panel.getByRole('button', { name: 'Send to model' }).click();
        const proposed = page.getByTestId('rf__node-slack');
        await expect(proposed).toContainText('Proposed step');
        const link = page.getByTestId(
          `rf__edge-receipt-${WORKFLOW_FAILURE_PORT}-slack`,
        );
        await expect(link).toBeAttached();
        await expect(
          page.getByText('on failure', { exact: true }).first(),
        ).toBeAttached();
        await expect(
          panel.getByRole('button', { name: 'Apply to draft' }),
        ).toBeInViewport();
        await checkCanvas(page, 'build-assistant', theme);
        await panel
          .getByRole('button', { name: 'Discard', exact: true })
          .click();
        await expect(proposed).toHaveCount(0);
        await expect(
          page.getByTestId(`rf__edge-receipt-${WORKFLOW_FAILURE_PORT}-slack`),
        ).toHaveCount(0);
      });

      test('shows the agent task first and opens its input mappings', async ({
        page,
      }) => {
        await installAgentRun(page);
        await page.goto(editorUrl);
        const step = page.getByTestId('rf__node-reply');
        await step.press('Enter');
        if (viewport.width < 1024) {
          await page.getByRole('button', { name: 'Step', exact: true }).click();
        }
        const inspector = page.getByRole('complementary', {
          name: 'Step panel',
        });
        await expect(
          inspector.getByRole('heading', { name: 'Task', exact: true }),
        ).toBeVisible();
        await expect(inspector.getByText(task, { exact: true })).toBeAttached();
        await expect(inspector.getByLabel('Last run output')).toBeAttached();
        await expect(
          inspector.getByText('Last run: Succeeded', { exact: true }),
        ).toBeAttached();
        await checkCanvas(page, 'build-ai-steps', theme);
        await inspector.getByRole('button', { name: 'Edit in Inputs' }).click();
        await expect(
          inspector.getByRole('tab', { name: 'Inputs', exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
      });
    });
  }
}
