import type { Page } from '@playwright/test';

export async function installPresenceRoutes(page: Page) {
  await page.route('**/v1/workspaces/*/workflows/*/presence**', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { people: [] } });
    if (route.request().method() === 'PUT')
      return route.fulfill({ json: { accepted: true } });
    return route.fallback();
  });
}

export async function installWorkflowSettingsReads(page: Page) {
  await page.route('**/step-health', (route) =>
    route.fulfill({
      json: { runsConsidered: 0, oldestRunAt: null, items: [] },
    }),
  );
  await page.route('**/failure-notification-destinations', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/failure-notification-policy', (route) =>
    route.fulfill({ json: { destination: null } }),
  );
  await page.route('**/versions?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
}
