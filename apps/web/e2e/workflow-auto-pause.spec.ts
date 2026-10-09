import { test, expect } from '@playwright/test';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowId,
  editorUrl,
} from './workflow-editor-support';
import { unpausedWorkflowSettings } from '../test/support/auto-pause-fixtures';
import type { WorkflowAutoPauseSettings } from '@pertexo/contracts';

const csrfToken = 'csrf-auto-pause-browser-tests-123456789012345678901';
const paused: WorkflowAutoPauseSettings = {
  ...unpausedWorkflowSettings,
  pauseState: 'paused',
  pauseRevision: '9007199254740993',
  pausedAt: '2026-09-30T10:00:00Z',
  pauseReason: 'consecutive_failures',
  pausedFailures: 10,
  pausedLastRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

test('workflow auto-pause settings preserve conflict edits and exact retries; Resume keeps bigint authority', async ({
  page,
  baseURL,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.context().addCookies([
    {
      name: 'pertexo_csrf',
      value: csrfToken,
      url: baseURL ?? 'http://127.0.0.1:4173',
    },
  ]);
  await installEditorRoutes(page, remoteDraft(), {
    accessibleWorkspace: {
      ...workspace,
      capabilities: [
        'workspace:read',
        'workspace:manage',
        'workflow:read',
        'workflow:update',
        'workflow:publish',
      ],
    },
  });
  let settings = paused;
  const writes: { body: unknown; key: string | undefined }[] = [];
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/auto-pause`,
    async (route) => {
      const request = route.request();
      if (request.method() === 'GET') return route.fulfill({ json: settings });
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      writes.push({
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'],
      });
      if (writes.length === 1) {
        settings = {
          ...settings,
          thresholdOverride: 12,
          effectiveThreshold: 12,
          settingsRevision: 2,
        };
        return route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'https://api.pertexo.test/problems/workflow.auto_pause_settings_conflict',
            title: 'Settings conflict',
            status: 409,
            code: 'workflow.auto_pause_settings_conflict',
            requestId: 'browser-autopause-conflict',
            currentSettingsRevision: 2,
          },
        });
      }
      settings = {
        ...settings,
        thresholdOverride: 5,
        effectiveThreshold: 5,
        settingsRevision: 3,
      };
      if (writes.length === 2) return route.abort('failed');
      return route.fulfill({ json: { settings, replayed: true } });
    },
  );
  let workspaceSettings = { threshold: 10, revision: 1 };
  await page.route(
    `**/v1/workspaces/${workspaceId}/auto-pause`,
    async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: workspaceSettings });
      expect(route.request().postDataJSON()).toEqual({
        threshold: 15,
        expectedRevision: 1,
      });
      workspaceSettings = { threshold: 15, revision: 2 };
      settings = { ...settings, workspaceThreshold: 15 };
      return route.fulfill({
        json: { settings: workspaceSettings, replayed: false },
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/resume`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      expect(route.request().postDataJSON()).toEqual({
        expectedPauseRevision: '9007199254740993',
      });
      settings = {
        ...settings,
        ...unpausedWorkflowSettings,
        pauseRevision: '9007199254740994',
      };
      return route.fulfill({ json: { settings: paused, replayed: true } });
    },
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
  await page.goto(`${editorUrl}/settings`);
  await expect(
    page.getByText('Schedules and webhooks are paused'),
  ).toBeVisible();
  const threshold = page.getByRole('textbox', {
    name: 'Pause after failures in a row',
  });
  await threshold.fill('5');
  await page.getByRole('button', { name: 'Save auto-pause rule' }).click();
  await expect(page.getByText(/Your edits are kept/u)).toBeVisible();
  await expect(threshold).toHaveValue('5');
  await expect(
    page.getByText('Current configured rule: 12 failures in a row.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save auto-pause rule' }).click();
  await page.getByRole('button', { name: 'Retry same change' }).click();
  await expect(page.getByText('Auto-pause settings saved')).toBeVisible();
  expect(writes).toHaveLength(3);
  expect(writes[1]).toEqual(writes[2]);
  expect(writes[1]?.body).toEqual({
    enabled: true,
    thresholdOverride: 5,
    expectedSettingsRevision: 2,
  });
  await page.getByRole('textbox', { name: 'Workspace default' }).fill('15');
  await page.getByRole('button', { name: 'Save workspace default' }).click();
  await expect(
    page.getByText('Workspace auto-pause default saved'),
  ).toBeVisible();
  await expect(
    page.getByText(/Leave blank to use the workspace default \(15\)/u),
  ).toBeVisible();
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: testInfo.outputPath('auto-pause-settings.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Resume triggers' }).click();
  await expect(page.getByText('Workflow triggers resumed')).toBeVisible();
  await expect(page.getByText('Schedules and webhooks are paused')).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
});

test('workflow auto-pause banner stays usable in the narrow Build view without permission to resume', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installEditorRoutes(page, remoteDraft(), {
    accessibleWorkspace: {
      ...workspace,
      role: 'viewer',
      capabilities: ['workspace:read', 'workflow:read'],
    },
  });
  await page.route('**/auto-pause', (route) => route.fulfill({ json: paused }));
  await page.goto(editorUrl);
  await expect(
    page.getByText('Schedules and webhooks are paused'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Resume triggers' }),
  ).toHaveCount(0);
  await expect(
    page.getByText('A workflow editor can resume these triggers.'),
  ).toBeVisible();
  const bounds = await page
    .getByText('Schedules and webhooks are paused')
    .boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath('auto-pause-build-mobile.png'),
    fullPage: true,
  });
});
