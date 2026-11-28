import { platformBrowserNodeDefinitionCatalog } from '../../../../packages/node-catalog/dist/index.js';
import { at, invoiceGraph } from './core-flow-invoice-graph';
import { fixtureRun, fixtureStatistics } from '../../test/support/fixtures/run';
import type { Page } from '../support/fixtures';
import { workflowListBody } from '../workflows/list-support';
import {
  workflowGraphReadBody,
  workflowVersionsBody,
} from '../workflows/read-projections';
import {
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspace,
  workspaceId,
} from '../workflow-editor/support';

// A workspace in the middle of a working day: a failed invoice run, a live
// one, two approvals waiting and the invoice workflow on the canvas, so each
// screenshot shows the states the core-flow pages are designed around.

export const failedRunId = '20000000-0000-4000-8000-000000000001';
const liveRunId = '20000000-0000-4000-8000-000000000002';
export const approvalId = '20000000-0000-4000-8000-000000000003';
const versionId = '20000000-0000-4000-8000-000000000004';
const syncWorkflowId = '20000000-0000-4000-8000-000000000005';
const remindersWorkflowId = '20000000-0000-4000-8000-000000000007';
export const secondApprovalId = '20000000-0000-4000-8000-000000000006';

/** `took`: started this many minutes ago, for this many seconds. */
function nodeRun(
  nodeId: string,
  status: string,
  [startedMinutesAgo, seconds]: readonly [number, number],
  extra: Record<string, unknown> = {},
) {
  const startedAt = at(startedMinutesAgo);
  return {
    id: crypto.randomUUID(),
    nodeId,
    invocationKey: nodeId,
    status,
    currentAttemptNumber: 1,
    startedAt,
    completedAt:
      status === 'running' || status === 'queued'
        ? null
        : new Date(Date.parse(startedAt) + seconds * 1000).toISOString(),
    resumeAt: null,
    safeErrorCode: null,
    ...extra,
  };
}

function run(id: string, status: string, minutesAgo: number) {
  return fixtureRun(id, status as 'failed', {
    workspaceId,
    workflowId,
    workflowVersionId: versionId,
    workflowName: 'Invoice intake',
    triggerType: 'webhook',
    createdAt: at(minutesAgo),
    updatedAt: at(minutesAgo - 1),
    startedAt: at(minutesAgo),
    completedAt:
      status === 'running' ? null : at(Math.max(0, minutesAgo - 1.2)),
  });
}

const failedRun = run(failedRunId, 'failed', 19);
const listedFailure = {
  ...failedRun,
  failedStep: {
    nodeId: 'receipt',
    label: 'Send receipt',
    definitionKey: 'email.send_notification',
    safeErrorCode: 'provider.unavailable',
  },
};
const liveRun = run(liveRunId, 'running', 1);

function failedNodes() {
  return [
    nodeRun('intake', 'succeeded', [19, 0.02]),
    nodeRun('check', 'succeeded', [19, 0.05]),
    nodeRun('over', 'succeeded', [19, 0.01]),
    nodeRun('erp', 'succeeded', [19, 2.6]),
    nodeRun('receipt', 'failed', [18.5, 0.4], {
      currentAttemptNumber: 3,
      safeErrorCode: 'provider.unavailable',
      errorSummary: 'Resend answered 503 Service Unavailable.',
    }),
  ];
}

function liveNodes() {
  return [
    nodeRun('intake', 'succeeded', [1, 0.02]),
    nodeRun('check', 'succeeded', [1, 0.05]),
    nodeRun('over', 'succeeded', [1, 0.01]),
    nodeRun('erp', 'running', [0.5, 0]),
  ];
}

function task(id: string, title: string, expiresInMinutes: number) {
  return {
    id,
    workspaceId,
    workflowId,
    workflowName: 'Invoice intake',
    runId: liveRunId,
    nodeId: 'approve',
    stepName: 'Finance approval',
    nodeRunId: crypto.randomUUID(),
    iterationPath: [],
    kind: 'approval',
    title,
    details: { Invoice: 'INV-2291', Amount: '7,480.00 EUR' },
    status: 'pending',
    createdAt: at(0.25),
    expiresAt: at(-expiresInMinutes),
    onExpiry: 'fail',
    completedAt: null,
    completedByName: null,
    canRespond: true,
    blockedReason: null,
  };
}

const tasks = [
  task(approvalId, 'Pay Fjord Supplies 7,480.00 EUR?', 23 * 60),
  task(secondApprovalId, 'Approve restock order PO-7716', 48),
];

/** Every read the core-flow pages make, answered with the day above. */
export async function installCoreFlowRoutes(
  page: Page,
  options: Readonly<{
    live?: boolean;
    /** The draft on the canvas; the invoice workflow unless given. */
    graph?: ReturnType<typeof invoiceGraph>;
  }> = {},
) {
  await page.route('**/v1/**', (route) => {
    if (process.env.PERTEXO_CORE_FLOW_SHOTS !== undefined)
      console.log(`unanswered ${route.request().url()}`);
    return route.fulfill({ status: 404 });
  });
  await page.route('**/presence/*', (route) => route.fulfill({ status: 204 }));
  await installEditorRoutes(
    page,
    remoteDraft(options.graph ?? invoiceGraph()),
    {
      definitions: platformBrowserNodeDefinitionCatalog().definitions,
      workflowName: 'Invoice intake',
      accessibleWorkspace: {
        ...workspace,
        role: 'owner',
        capabilities: [
          ...workspace.capabilities,
          'workflow:create',
          'run:replay',
          'member:read',
        ],
      },
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      route.fulfill({ json: workflowSummary('Invoice intake', versionId) }),
  );
  await page.route('**/v1/workspaces/*/run-statistics?**', (route) =>
    route.fulfill({
      json: fixtureStatistics({
        window:
          new URL(route.request().url()).searchParams.get('window') ?? '24h',
        byStatus: { failed: 1, running: 1 },
        workflows: [{ workflowId, workflowName: 'Invoice intake', total: 2 }],
        current: { running: 1, waiting: 2 },
      }),
    }),
  );
  const runs = [
    ...(options.live === true ? [liveRun] : []),
    listedFailure,
    ...Array.from({ length: 8 }, (_, index) => ({
      ...run(
        `20000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
        'succeeded',
        20 + index,
      ),
      workflowId: syncWorkflowId,
      workflowName: 'Hourly stock sync',
    })),
  ];
  await page.route('**/v1/workspaces/*/runs?**', (route) => {
    const status = new URL(route.request().url()).searchParams.get('status');
    void route.fulfill({
      json: {
        items: runs.filter((item) => status === null || item.status === status),
        nextCursor: null,
      },
    });
  });
  await page.route(`**/v1/workspaces/*/runs/${failedRunId}`, (route) =>
    route.fulfill({ json: { run: failedRun, nodes: failedNodes() } }),
  );
  await page.route(`**/v1/workspaces/*/runs/${liveRunId}`, (route) =>
    route.fulfill({ json: { run: liveRun, nodes: liveNodes() } }),
  );
  await page.route(`**/v1/workspaces/*/pending-tasks?**`, (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    const items = kind === 'input_request' ? [] : tasks;
    return route.fulfill({
      json: { items, nextCursor: null, pendingCount: items.length },
    });
  });
  for (const task of tasks) {
    await page.route(`**/v1/workspaces/*/pending-tasks/${task.id}`, (route) =>
      route.fulfill({
        json: {
          task: {
            ...task,
            workflowVersionId: versionId,
            instructions:
              'Invoices over 5,000 need a second look. Check that it matches a purchase order before it goes to the ERP.',
            audience: { roles: ['owner', 'admin'], memberIds: [] },
            output: null,
          },
        },
      }),
    );
  }
  await page.route('**/v1/workspaces/*/runs/*/node-runs/*/input', (route) =>
    route.fulfill({ json: { input: { kind: 'none' } } }),
  );
  await page.route('**/v1/workspaces/*/runs/*/node-runs/*/output', (route) =>
    route.fulfill({ json: { output: { kind: 'none' } } }),
  );
  await page.route('**/v1/workspaces/*/workflow-folders', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/v1/workspaces/*/workflow-tags?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/workspaces/*/notifications?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null, revision: '0' } }),
  );
  await page.route('**/v1/workspaces/*/members?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  // The shell's own reads, which the catch-all above would otherwise answer.
  await page.route('**/v1/workspaces/*/notifications/summary', (route) =>
    route.fulfill({ json: { unreadCount: 2, revision: '0' } }),
  );
  await page.route('**/v1/workspaces/*/notifications/events', (route) =>
    route.fulfill({
      headers: { 'content-type': 'text/event-stream' },
      body: 'retry: 60000\n\n',
    }),
  );
  await page.route('**/v1/workspaces/*/runs/*/events', (route) =>
    route.fulfill({
      headers: { 'content-type': 'text/event-stream' },
      body: 'retry: 60000\n\n',
    }),
  );
  await page.route(
    '**/v1/workspaces/*/workflows/*/publication-review',
    (route) => route.fulfill({ json: { required: false, request: null } }),
  );
  await page.route(
    '**/v1/workspaces/*/failure-notification-destinations',
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/v1/workspaces/*/workflows/*/comments**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  for (const id of [syncWorkflowId, remindersWorkflowId])
    await page.route(
      `**/v1/workspaces/*/workflows/${id}/draft**`,
      async (route) =>
        route.fulfill({
          json: await workflowGraphReadBody(route.request().url(), {
            workflowId: id,
            revision: 1,
            graph: invoiceGraph(),
            updatedAt: at(60),
          }),
        }),
    );
  await page.route(
    '**/v1/workspaces/*/workflows/*/versions?**',
    async (route) =>
      route.fulfill({
        json: await workflowVersionsBody(route.request().url(), {
          items: [
            {
              id: versionId,
              workflowId,
              versionNumber: 3,
              graph: invoiceGraph(),
              checksum: `wf:sha256:${'b'.repeat(64)}`,
              publishedAt: at(60 * 24),
            },
          ],
          nextCursor: null,
        }),
      }),
  );
  await page.route('**/v1/workspaces/*/workflows?**', (route) =>
    route.fulfill({
      json: workflowListBody(route.request().url(), workflowList()),
    }),
  );
}

function shapeOf(graph: ReturnType<typeof invoiceGraph>) {
  return {
    nodes: graph.nodes.map(({ id, definition, position, label }) => ({
      id,
      definition,
      position,
      label,
    })),
    edges: graph.edges,
  };
}

function listed(
  id: string,
  name: string,
  recentRuns: readonly Readonly<{ status: string; createdAt: string }>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    workspaceId,
    name,
    nameRevision: 1,
    listSummary: { shape: shapeOf(invoiceGraph()), recentRuns },
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'active',
    webhookSetupRequired: false,
    publishedVersionId: versionId,
    createdAt: at(60 * 24 * 30),
    updatedAt: at(22),
    ...overrides,
  };
}

function workflowList() {
  const hourly = Array.from({ length: 20 }, (_, index) => ({
    status: index === 9 ? 'failed' : 'succeeded',
    createdAt: at(60 * 6 * index + 5),
  }));
  return [
    listed(workflowId, 'Invoice intake', [
      { status: 'running', createdAt: at(1) },
      { status: 'failed', createdAt: at(19) },
      { status: 'succeeded', createdAt: at(60 * 30) },
      { status: 'failed', createdAt: at(60 * 50) },
    ]),
    listed(syncWorkflowId, 'Hourly stock sync', hourly),
    listed(remindersWorkflowId, 'Supplier reminders', [], {
      activationStatus: 'inactive',
      publishedVersionId: null,
      updatedAt: at(60),
    }),
  ];
}
