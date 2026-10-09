import { test, expect } from '@playwright/test';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowId,
  editorUrl,
} from './workflow-editor-support';
import { defaultConcurrencySettings } from '../test/support/fixtures/concurrency';

async function settingsReads(page: Parameters<typeof installEditorRoutes>[0]) {
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

test('workflow concurrency preserves conflict edits, exact retries and queue-only settings on a narrow screen', async ({
  page,
  baseURL,
}, testInfo) => {
  const csrf = 'csrf-concurrency-browser-tests-123456789012345678901';
  await page.context().addCookies([
    {
      name: 'pertexo_csrf',
      value: csrf,
      url: baseURL ?? 'http://127.0.0.1:4173',
    },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installEditorRoutes(page, remoteDraft());
  await settingsReads(page);
  let settings = defaultConcurrencySettings;
  const writes: { body: unknown; key: string | undefined }[] = [];
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/concurrency`,
    async (route) => {
      const request = route.request();
      if (request.method() === 'GET') return route.fulfill({ json: settings });
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      writes.push({
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'],
      });
      if (writes.length === 1) {
        settings = { ...settings, limit: 3, revision: 2 };
        return route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'https://api.pertexo.test/problems/workflow.concurrency_revision_conflict',
            title: 'Settings conflict',
            status: 409,
            code: 'workflow.concurrency_revision_conflict',
            requestId: 'concurrency-browser',
            currentRevision: 2,
          },
        });
      }
      const body = request.postDataJSON() as { limit: number | null };
      if (writes.length !== 3)
        settings = {
          ...settings,
          limit: body.limit,
          revision: settings.revision + 1,
        };
      if (writes.length === 2) return route.abort('failed');
      return route.fulfill({
        json: { settings, replayed: writes.length === 3 },
      });
    },
  );
  await page.goto(`${editorUrl}/settings`);
  const section = page.getByRole('region', { name: 'Concurrency' });
  const input = section.getByRole('textbox', { name: 'Runs at once' });
  await input.fill('1');
  await section.getByRole('button', { name: 'Save concurrency limit' }).click();
  await expect(section.getByText(/Your edits are kept/u)).toBeVisible();
  await expect(input).toHaveValue('1');
  await expect(
    section.getByText(
      'Current limit: 3 active runs. Workspace limits still apply.',
    ),
  ).toBeVisible();
  await section.getByRole('button', { name: 'Save concurrency limit' }).click();
  await section.getByRole('button', { name: 'Retry same change' }).click();
  await expect(page.getByText('Concurrency settings saved')).toBeVisible();
  expect(writes[2]).toEqual(writes[1]);
  expect(writes[2]?.body).toEqual({ limit: 1, expectedRevision: 2 });
  await input.fill('');
  await section.getByRole('button', { name: 'Save concurrency limit' }).click();
  await expect(
    section.getByText(
      'Current limit: no additional workflow limit. Workspace limits still apply.',
    ),
  ).toBeVisible();
  expect(writes[3]?.body).toEqual({ limit: null, expectedRevision: 3 });
  await input.focus();
  await page.keyboard.press('Tab');
  await expect(
    section.getByRole('button', { name: 'Save concurrency limit' }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('concurrency-mobile.png'),
    fullPage: true,
  });
});

test('workflow concurrency is readable but not editable by a viewer', async ({
  page,
}) => {
  await installEditorRoutes(page, remoteDraft(), {
    accessibleWorkspace: {
      ...workspace,
      role: 'viewer',
      capabilities: ['workspace:read', 'workflow:read'],
    },
  });
  await settingsReads(page);
  await page.goto(`${editorUrl}/settings`);
  const section = page.getByRole('region', { name: 'Concurrency' });
  await expect(
    section.getByText(
      'Current limit: no additional workflow limit. Workspace limits still apply.',
    ),
  ).toBeVisible();
  await expect(section.getByRole('textbox')).toHaveCount(0);
  await expect(
    section.getByText(/Extra runs wait their turn in acceptance order/u),
  ).toBeVisible();
});
