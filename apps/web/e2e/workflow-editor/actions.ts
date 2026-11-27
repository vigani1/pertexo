import { expect, type Page } from '@playwright/test';
export async function openWorkflowAction(page: Page, name: string) {
  await openWorkflowMenu(page);
  await page.getByRole('menuitem', { name, exact: true }).click();
}

export async function openWorkflowMenu(page: Page) {
  await page
    .getByRole('button', { name: 'More workflow actions', exact: true })
    .click();
}

export async function openStepPalette(page: Page) {
  const palette = page.getByRole('complementary', { name: 'Add a step' });
  if (await palette.getByRole('searchbox').isVisible()) return;
  await page
    .getByRole('button', {
      name:
        (page.viewportSize()?.width ?? 1280) < 1024 ? 'Add step' : 'Show steps',
      exact: true,
    })
    .click();
}

export async function addStep(page: Page, name: RegExp) {
  await openStepPalette(page);
  return page
    .getByRole('complementary', { name: 'Add a step' })
    .getByRole('button', { name });
}

export function blocksUnload(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

/**
 * Focuses a step's card, as a keyboard user reaches it. React Flow keeps a
 * card hidden until it has measured it, and a hidden card can't take focus:
 * focusing it then does nothing, and a key pressed next goes to the page.
 */
export async function focusStep(page: Page, nodeId: string) {
  const step = page.getByTestId(`rf__node-${nodeId}`);
  await expect(step).toBeVisible();
  await step.focus();
  await expect(step).toBeFocused();
}
