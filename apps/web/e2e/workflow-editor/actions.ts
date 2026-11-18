import { expect, type Page } from '@playwright/test';
import { FOLDED_WORKFLOW_ACTIONS } from './support';
export async function openWorkflowAction(page: Page, name: string) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < (FOLDED_WORKFLOW_ACTIONS.has(name) ? 1536 : 640)) {
    await page
      .getByRole('button', { name: 'More workflow actions', exact: true })
      .click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  } else {
    await page.getByRole('button', { name, exact: true }).click();
  }
}

export function addStep(page: Page, name: RegExp) {
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
