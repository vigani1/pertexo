import { API_TOKEN_SCOPES } from '@pertexo/policy';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
} from '../workflow-editor/support';
import { settings as federation } from '../../test/features/federation/fixtures';
import { fixtureUsageTrends } from '../../test/support/fixtures/usage-trends';
import {
  fixtureRun,
  fixtureStatistics,
  minutesAgo,
} from '../../test/support/fixtures/run';
import { deferred } from '../../test/support/fixtures/workflow-editor';
import { expect, type Page } from '../support/fixtures';

export const tableId = '10000000-0000-4000-8000-000000000001';
export const runId = '10000000-0000-4000-8000-000000000002';
const table = {
  id: tableId,
  name: 'Customer orders',
  columns: [
    { id: 'reference', name: 'reference', type: 'text', required: true },
  ],
  keyColumn: null,
  hasRemovedColumns: false,
  rowCount: 0,
  storedBytes: 0,
  revision: 1,
};
const quotas = {
  tableLimit: 20,
  columnLimit: 20,
  rowLimit: 10000,
  byteLimit: 52428800,
  tableCount: 0,
  storedBytes: 0,
};
export async function installPolishRoutes(
  page: Page,
  options: Readonly<{
    draft?: ReturnType<typeof remoteDraft>;
    definitions?: readonly unknown[];
  }> = {},
) {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/presence/*', (route) => route.fulfill({ status: 204 }));
  await installEditorRoutes(page, options.draft ?? remoteDraft(), {
    ...(options.definitions === undefined
      ? {}
      : { definitions: options.definitions }),
    accessibleWorkspace: {
      ...workspace,
      role: 'owner',
      capabilities: [
        ...workspace.capabilities,
        'workspace:manage',
        'workflow:create',
        'member:read',
        'member:manage',
        'connection:manage',
        'notification:read',
        'variable:manage',
        'audit:read',
        'governance:manage',
        'artifact:read',
      ],
    },
  });
  await page.route('**/v1/workspaces/*/run-statistics?**', (route) =>
    route.fulfill({
      json: fixtureStatistics({
        window:
          new URL(route.request().url()).searchParams.get('window') ?? '24h',
        workflows: [],
        current: { running: 2 },
      }),
    }),
  );
  const createdAt = new Date().toISOString();
  await page.route('**/v1/workspaces/*/runs?**', (route) =>
    route.fulfill({
      json: {
        items: [
          fixtureRun(runId, 'running', { createdAt, startedAt: createdAt }),
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/v1/workspaces/*/runs/${runId}`, (route) =>
    route.fulfill({ json: { run: fixtureRun(runId, 'succeeded'), nodes: [] } }),
  );
  await page.route('**/v1/workspaces/*/notifications?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null, revision: '0' } }),
  );
  await page.route('**/v1/workspaces/*/members?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/workspaces/*/invitations?**', (route) =>
    route.fulfill({
      json: { items: [], nextCursor: null, issuanceAvailable: true },
    }),
  );
  await page.route('**/v1/workspaces/*/data-tables', (route) =>
    route.fulfill({
      json: {
        tables: new URL(page.url()).pathname.includes(tableId) ? [table] : [],
        quotas,
      },
    }),
  );
  await page.route('**/v1/workspaces/*/data-tables/*/rows/query', (route) =>
    route.fulfill({ json: { rows: [], affected: 0, hasMore: false } }),
  );
  await page.route('**/v1/workspaces/*/variables', (route) =>
    route.fulfill({ json: { revision: 0, values: {} } }),
  );
  await page.route('**/v1/workspaces/*/usage-capacity', (route) =>
    route.fulfill({
      json: {
        asOf: '2026-09-15T10:00:00.000000Z',
        execution: {
          activeRuns: 2,
          reservedActiveSlots: 1,
          activeCapacityConsumed: 3,
          queuedRuns: 4,
          policy: {
            state: 'active',
            version: 1,
            activeRunLimit: 5,
            queuedRunLimit: 100,
          },
        },
        artifacts: {
          chargedBytes: '1024',
          byteLimit: '52428800',
          chargedCount: 2,
          artifactCountLimit: 1000,
          source: 'stored',
        },
      },
    }),
  );
  await page.route('**/v1/workspaces/*/usage-trends?**', (route) =>
    route.fulfill({
      json: fixtureUsageTrends('30d', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    }),
  );
  await page.route('**/v1/workspaces/*/sso', (route) =>
    route.fulfill({ json: federation }),
  );
  await page.route('**/v1/workspaces/*/notifications/preferences', (route) =>
    route.fulfill({
      json: {
        revision: 0,
        mode: null,
        hour: 9,
        timeZone: 'UTC',
        defaults: { revision: 0, mode: 'off', hour: 9, timeZone: 'UTC' },
        effective: { mode: 'off', hour: 9, timeZone: 'UTC' },
        canManageDefaults: true,
        emailAvailable: true,
        emailUnavailableReason: null,
      },
    }),
  );
  await page.route('**/v1/workspaces/*/promotions/settings', (route) =>
    route.fulfill({ json: { revision: 0, canConfigure: true, target: null } }),
  );
  await page.route('**/v1/workspaces/*/promotions/history?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/workspaces/*/promotions/candidates?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/workspaces/*/governance/settings', (route) =>
    route.fulfill({ json: { revision: 1, auditRetentionDays: 365 } }),
  );
  await page.route('**/v1/workspaces/*/governance/audit?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    '**/v1/workspaces/*/failure-notification-destinations',
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/v1/workspaces/*/api-tokens?**', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        availableScopes: API_TOKEN_SCOPES,
        items: [],
        nextCursor: null,
      },
    }),
  );
}

export async function showInboxArrival(page: Page) {
  const change = deferred<undefined>();
  let revision = '1';
  await page.route('**/v1/workspaces/*/notifications/summary', (route) =>
    route.fulfill({ json: { unreadCount: Number(revision), revision } }),
  );
  await page.route('**/v1/workspaces/*/notifications?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            noticeKind: 'workflow_failure',
            workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            workflowName: 'Nightly import',
            kind: 'failed',
            failureDays: [],
            occurrenceCount: 2,
            firstOccurredAt: minutesAgo(2).replace(/Z$/, '000Z'),
            latestOccurredAt: minutesAgo(0).replace(/Z$/, '000Z'),
            latestRunId: runId,
            latestFailedStep: null,
            revision,
            unread: true,
          },
        ],
        nextCursor: null,
        revision,
      },
    }),
  );
  await page.route('**/v1/workspaces/*/notifications/events', async (route) => {
    await change.promise;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: 'event: inbox.ready\ndata: {"revision":null}\n\nevent: inbox.changed\ndata: {"revision":"2"}\n\n',
    });
  });
  await page.goto(`/w/${workspaceId}`);
  await expect(
    page.getByRole('link', { name: 'Inbox, 1 unread' }),
  ).toBeVisible();
  revision = '2';
  change.resolve(undefined);
  const notice = page.getByRole('dialog', { name: 'Nightly import' });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCSS('opacity', '1');
  return notice;
}

export async function captureInboxArrival(
  page: Page,
  shot: (name: string) => Promise<void>,
) {
  const notice = await showInboxArrival(page);
  await shot('inbox-arrival');
  await notice.hover();
  await expect(
    notice.getByRole('button', { name: 'Dismiss notification' }),
  ).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(notice).toBeHidden();
}
