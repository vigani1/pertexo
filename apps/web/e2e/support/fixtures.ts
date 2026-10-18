import { test as base } from '@playwright/test';

export {
  expect,
  type Page,
  type Locator,
  type BrowserContext,
} from '@playwright/test';

/** Shell requests stay mocked even when a scenario does not exercise the Inbox. */
export const test = base.extend({
  page: async ({ page }, runWithPage) => {
    await page.route('**/v1/workspaces/*/workflows/*/presence**', (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: { people: [] } });
      if (route.request().method() === 'PUT')
        return route.fulfill({ json: { accepted: true } });
      return route.fallback();
    });
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
