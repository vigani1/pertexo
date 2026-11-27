import {
  normalizeWorkflowRunCreatedAt,
  workflowRunStatisticsQuerySchema,
} from '@pertexo/contracts';
import type { Page } from '@playwright/test';
import { formConfigSchema } from '@pertexo/workflow-model';
import { workflowListBody } from '../../workflows/list-support';
import {
  fixtureRun,
  fixtureStatistics,
  type RunFixtureStatus,
  minutesAgo,
} from '../../../test/support/fixtures/run';
import { user, workflowId, workspaceId } from '../../workflow-editor/support';
import { runId } from '../polish-layout-fixture';
import { liveVersionId, workflowSummary } from './workflow-data';

const workspaceApi = `**/v1/workspaces/${workspaceId}`;
const workflowApi = `${workspaceApi}/workflows/${workflowId}`;

export const taskId = '11000000-0000-4000-8000-000000000003';
export const requestId = '11000000-0000-4000-8000-000000000004';
export const reviewId = '11000000-0000-4000-8000-000000000005';
export const formId = '11000000-0000-4000-8000-000000000001';
export const succeededRunId = '11000000-0000-4000-8000-000000000002';
export const form = formConfigSchema.parse({
  title: 'Submit a supplier invoice',
  instructions: 'Send the invoice and purchase order to Finance.',
  fields: [
    { id: 'company', name: 'company', label: 'Your company', type: 'text' },
    { id: 'invoice', name: 'invoice', label: 'Invoice number', type: 'text' },
    {
      id: 'currency',
      name: 'currency',
      label: 'Currency',
      type: 'select',
      options: ['EUR', 'USD'],
    },
    { id: 'amount', name: 'amount', label: 'Amount', type: 'number' },
    {
      id: 'file',
      name: 'file',
      label: 'The invoice',
      type: 'file',
      accept: ['documents'],
    },
    {
      id: 'notes',
      name: 'notes',
      label: 'Notes',
      type: 'textarea',
      required: false,
    },
  ],
});

export async function installActivityRoutes(page: Page) {
  const running = activityRun(runId, 'running', 8);
  const succeeded = activityRun(succeededRunId, 'succeeded', 38, 32);
  const failed = activityRun(
    '11000000-0000-4000-8000-000000000007',
    'failed',
    15,
    12,
  );
  const timedOut = activityRun(
    '11000000-0000-4000-8000-000000000008',
    'timed_out',
    20,
    17,
  );
  const unknown = activityRun(
    '11000000-0000-4000-8000-000000000021',
    'outcome_unknown',
    25,
    22,
  );
  const runs = [running, failed, timedOut, unknown, succeeded];
  await page.route(`${workspaceApi}/workflows?**`, (route) =>
    route.fulfill({
      json: workflowListBody(route.request().url(), [workflowSummary.workflow]),
    }),
  );
  for (const path of [`${workspaceApi}/runs?**`, `${workflowApi}/runs?**`])
    await page.route(path, (route) =>
      route.fulfill({
        json: {
          items: activityRuns(
            runs,
            new URL(route.request().url()).searchParams,
          ),
          nextCursor: null,
        },
      }),
    );
  await page.route(`${workspaceApi}/runs/${succeededRunId}`, (route) =>
    route.fulfill({
      json: {
        run: succeeded,
        nodes: ['start', 'extract', 'post'].map((nodeId, index) => ({
          id: `11000000-0000-4000-8000-00000000001${String(index)}`,
          nodeId,
          invocationKey: nodeId,
          status: 'succeeded',
          currentAttemptNumber: 1,
          resumeAt: null,
          safeErrorCode: null,
          startedAt: succeeded.startedAt,
          completedAt: succeeded.completedAt,
        })),
      },
    }),
  );
  for (const run of [running, failed, timedOut, unknown])
    await page.route(`${workspaceApi}/runs/${run.id}`, (route) =>
      route.fulfill({ json: { run, nodes: [] } }),
    );
  await page.route(`${workspaceApi}/run-statistics?**`, (route) => {
    const asOf = new Date();
    const query = new URL(route.request().url()).searchParams;
    const { window = '24h', breakdown } =
      workflowRunStatisticsQuerySchema.parse(Object.fromEntries(query));
    const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 24 * 7 }[window];
    const createdAtFrom = normalizeWorkflowRunCreatedAt(
      new Date(asOf.getTime() - hours * 3_600_000).toISOString(),
    );
    const createdAtBefore = normalizeWorkflowRunCreatedAt(asOf.toISOString());
    const windowedRuns = activityRuns(
      runs,
      new URLSearchParams({ createdAtFrom, createdAtBefore }),
    );
    const byStatus: Partial<Record<RunFixtureStatus, number>> = {};
    for (const run of windowedRuns) {
      byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    }
    const statistics = fixtureStatistics({
      window,
      current: {
        running: runs.filter((run) => run.status === 'running').length,
      },
      byStatus,
    });
    return route.fulfill({
      json: {
        ...statistics,
        asOf: createdAtBefore,
        window: { ...statistics.window, createdAtFrom, createdAtBefore },
        workflows:
          breakdown === 'workflow'
            ? {
                items: [
                  {
                    workflowId,
                    workflowName: workflowSummary.workflow.name,
                    total: statistics.window.total,
                    byStatus: statistics.window.byStatus,
                  },
                ],
                truncated: false,
              }
            : null,
      },
    });
  });
  await page.route(`${workspaceApi}/governance/audit?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: '11000000-0000-4000-8000-000000000009',
            actorId: user.id,
            actorName: 'Dena Okafor',
            action: 'workflow.published',
            targetType: 'workflow',
            targetId: workflowId,
            occurredAt: minutesAgo(32),
            metadata: { workflowName: 'Invoice intake', versionNumber: 3 },
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await installReviewRoutes(page);
}

function activityRun(
  id: string,
  status: RunFixtureStatus,
  startedMinutesAgo: number,
  completedMinutesAgo?: number,
) {
  const startedAt = minutesAgo(startedMinutesAgo);
  const completedAt =
    completedMinutesAgo === undefined ? null : minutesAgo(completedMinutesAgo);
  return fixtureRun(id, status, {
    workspaceId,
    workflowId,
    workflowName: workflowSummary.workflow.name,
    workflowVersionId: liveVersionId,
    createdAt: startedAt,
    startedAt,
    completedAt,
    updatedAt: completedAt ?? startedAt,
  });
}

function activityRuns(
  runs: readonly ReturnType<typeof fixtureRun>[],
  query: URLSearchParams,
) {
  const status = query.get('status');
  const from = query.get('createdAtFrom');
  const before = query.get('createdAtBefore');
  const limit = query.get('limit');
  return runs
    .filter(
      (run) =>
        (status === null || run.status === status) &&
        (from === null || Date.parse(run.createdAt) >= Date.parse(from)) &&
        (before === null || Date.parse(run.createdAt) < Date.parse(before)),
    )
    .slice(0, limit === null ? runs.length : Number(limit));
}

async function installReviewRoutes(page: Page) {
  const task = {
    id: taskId,
    workspaceId,
    workflowId,
    workflowName: 'Invoice intake',
    workflowVersionId: liveVersionId,
    runId,
    nodeId: 'extract',
    stepName: 'Read the invoice',
    nodeRunId: '11000000-0000-4000-8000-000000000006',
    iterationPath: [],
    kind: 'approval',
    title: 'Review invoice',
    instructions: 'Confirm the invoice total with Finance.',
    details: { Amount: 7480, Supplier: 'Fjord Supplies' },
    audience: { roles: ['owner'], memberIds: [] },
    status: 'pending',
    createdAt: minutesAgo(4),
    expiresAt: minutesAgo(-60),
    onExpiry: 'fail',
    completedAt: null,
    completedByName: null,
    output: null,
    canRespond: true,
    blockedReason: null,
  };
  await page.route(`${workspaceApi}/pending-tasks/${taskId}`, (route) =>
    route.fulfill({ json: { task } }),
  );
  await page.route(`${workspaceApi}/pending-tasks/${requestId}`, (route) =>
    route.fulfill({
      json: {
        task: {
          ...task,
          id: requestId,
          kind: 'input_request',
          title: 'Complete invoice reference',
          fields: form.fields.filter((field) => field.type !== 'file'),
        },
      },
    }),
  );
  await page.route(`${workflowApi}/publication-review`, (route) =>
    route.fulfill({ json: { required: false, request: null } }),
  );
  await page.route(
    `${workspaceApi}/publication-requests/${reviewId}`,
    (route) =>
      route.fulfill({
        json: {
          request: {
            id: reviewId,
            workflowId,
            workflowName: 'Invoice intake',
            requestedBy: user.id,
            requesterName: 'Dena Okafor',
            draftRevision: 1,
            note: 'Check the new invoice fields before publishing.',
            status: 'pending',
            createdAt: minutesAgo(10),
            expiresAt: minutesAgo(-60),
            decidedBy: null,
            deciderName: null,
            decidedAt: null,
            comment: null,
            publishedVersionId: null,
            versionNumber: null,
            canDecide: false,
          },
          graph: null,
          liveGraph: null,
        },
      }),
  );
}
