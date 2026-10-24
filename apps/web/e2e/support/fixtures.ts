import { installPresenceRoutes } from '../../test/support/browser/mock-reads';
import { test as base, type Page } from '@playwright/test';

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

/**
 * Opens a workflow test action: from the split Test workflow button, or on
 * phones (below `sm`) from the editor's ⋯ menu, where the split button hides.
 */
export async function chooseTestAction(
  page: Page,
  action: 'Test workflow' | 'Run all tests' | 'Test history',
) {
  if ((page.viewportSize()?.width ?? 1280) < 640)
    await page
      .getByRole('button', { name: 'More workflow actions', exact: true })
      .click();
  else if (action === 'Test workflow') {
    await page
      .getByRole('button', { name: 'Test workflow', exact: true })
      .click();
    return;
  } else
    await page
      .getByRole('button', { name: 'More test actions', exact: true })
      .click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
