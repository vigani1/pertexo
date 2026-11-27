import { installPresenceRoutes } from '../../test/support/browser/mock-reads';
import type { Locator, Page } from '@playwright/test';
import { test as base } from './coverage';

export {
  expect,
  type Page,
  type Locator,
  type BrowserContext,
} from '@playwright/test';

/** Shell requests stay mocked even when a scenario does not exercise the Inbox. */
export const test = base.extend({
  page: async ({ page }, runWithPage) => {
    await installPresenceRoutes(page);
    await page.route(
      '**/v1/workspaces/*/workflows/*/publication-review',
      (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { required: false, request: null } })
          : route.fallback(),
    );
    // Selected-step tests share this metadata read; pin journeys override it.
    await page.route('**/v1/workspaces/*/workflows/*/draft/samples', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: {
              items: [],
              draftRevision: 1,
              limits: { inlineBytes: 262144, depth: 64, members: 10000 },
            },
          })
        : route.fallback(),
    );
    await page.route('**/v1/workspaces/*/notifications/summary', (route) =>
      route.fulfill({ json: { unreadCount: 0, revision: '0' } }),
    );
    await page.route('**/v1/workspaces/*/notifications/events', (route) =>
      route.fulfill({
        headers: { 'content-type': 'text/event-stream' },
        body: 'retry: 60000\n\n',
      }),
    );
    // Scenario-specific routes registered by a test take precedence.
    await runWithPage(page);
  },
});

/** Choose a draft test or a secondary action in Test and run. */
export async function chooseTestAction(
  page: Page,
  action: 'Test workflow' | 'Run all tests' | 'Test history',
) {
  if (action === 'Test workflow') {
    await page.getByRole('button', { name: action, exact: true }).click();
    return;
  }
  await page
    .getByRole('button', { name: 'Test and run actions', exact: true })
    .click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
/**
 * Saves a dialog with Enter after its focused control was removed. The dialog
 * restores focus over the next frame, so wait until Save is actionable or the
 * key lands on the dialog itself.
 */
export async function saveWithEnter(scope: Locator) {
  const save = scope.getByRole('button', { name: 'Save', exact: true });
  await save.click({ trial: true });
  await save.press('Enter');
}
