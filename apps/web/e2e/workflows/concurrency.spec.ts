import { installWorkflowSettingsReads } from '../../test/support/browser/mock-reads';
import { test, expect } from '../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowId,
  editorUrl,
} from '../workflow-editor/support';
import { defaultConcurrencySettings } from '../../test/support/fixtures/concurrency';

test('workflow concurrency preserves conflict edits, exact retries and Queue/Skip settings on a narrow screen', async ({
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
  await installWorkflowSettingsReads(page);
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
      const body = request.postDataJSON() as {
        limit: number | null;
        overflow: 'queue' | 'skip';
      };
      if (writes.length !== 3)
        settings = {
          ...settings,
          limit: body.limit,
          overflow: body.overflow,
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
  await section.getByRole('button', { name: 'Change' }).click();
  const input = section.getByRole('textbox', { name: 'Runs at once' });
  await input.fill('1');
  await section.getByRole('button', { name: 'Save concurrency limit' }).click();
  await expect(section.getByText(/Your edits are kept/u)).toBeVisible();
  await expect(input).toHaveValue('1');
  await expect(section.getByText('Up to 3 runs at once.')).toBeVisible();
  await section.getByRole('button', { name: 'Save concurrency limit' }).click();
  await section.getByRole('button', { name: 'Retry same change' }).click();
  await expect(page.getByText('Concurrency settings saved')).toBeVisible();
  expect(writes[2]).toEqual(writes[1]);
  expect(writes[2]?.body).toEqual({
    limit: 1,
    expectedRevision: 2,
    overflow: 'queue',
  });
  await section.getByRole('button', { name: 'Change' }).click();
  await section
    .getByRole('combobox', { name: 'When the limit is reached' })
    .click();
  await page.getByRole('option', { name: 'Skip', exact: true }).click();
  await input.fill('');
  await section.getByRole('button', { name: 'Save concurrency limit' }).click();
  await expect(section.getByText(/^No limit of its own\./u)).toBeVisible();
  expect(writes[3]?.body).toEqual({
    limit: null,
    expectedRevision: 3,
    overflow: 'skip',
  });
  await section.getByRole('button', { name: 'Change' }).click();
  await input.focus();
  await page.keyboard.press('Tab');
  await expect(
    section.getByRole('combobox', { name: 'When the limit is reached' }),
  ).toBeFocused();
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
  await installWorkflowSettingsReads(page);
  await page.goto(`${editorUrl}/settings`);
  const section = page.getByRole('region', { name: 'Concurrency' });
  await expect(section.getByText(/^No limit of its own\./u)).toBeVisible();
  await expect(section.getByRole('textbox')).toHaveCount(0);
  await expect(
    section.getByText(/Your role or the workspace’s state doesn’t allow/u),
  ).toBeVisible();
});
