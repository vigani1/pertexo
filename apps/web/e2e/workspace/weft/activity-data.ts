import type { Page } from '@playwright/test';
import { formConfigSchema } from '@pertexo/workflow-model';
import { workflowListBody } from '../../workflows/list-support';
import {
  fixtureRun,
  fixtureStatistics,
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
export const form = formConfigSchema.parse({
  title: 'Submit a supplier invoice',
  instructions: 'Send the invoice and purchase order to Finance.',
  fields: [
    { id: 'company', name: 'company', label: 'Your company', type: 'text' },
    { id: 'invoice', name: 'invoice', label: 'Invoice number', type: 'text' },
    { id: 'amount', name: 'amount', label: 'Amount in EUR', type: 'number' },
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
  const running = fixtureRun(runId, 'running', {
    workflowId,
    workflowName: workflowSummary.workflow.name,
    workflowVersionId: liveVersionId,
    createdAt: minutesAgo(8),
    startedAt: minutesAgo(8),
  });
  const succeeded = fixtureRun(
    '11000000-0000-4000-8000-000000000002',
    'succeeded',
    {
      ...running,
      id: '11000000-0000-4000-8000-000000000002',
      status: 'succeeded',
      createdAt: minutesAgo(38),
      startedAt: minutesAgo(38),
      completedAt: minutesAgo(32),
    },
  );
  await page.route(`${workspaceApi}/workflows?**`, (route) =>
    route.fulfill({
      json: workflowListBody(route.request().url(), [workflowSummary.workflow]),
    }),
  );
  for (const path of [`${workspaceApi}/runs?**`, `${workflowApi}/runs?**`])
    await page.route(path, (route) =>
      route.fulfill({
        json: { items: [running, succeeded], nextCursor: null },
      }),
    );
  await page.route(`${workspaceApi}/runs/${runId}`, (route) =>
    route.fulfill({
      json: {
        run: { ...succeeded, id: runId },
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
  await page.route(`${workspaceApi}/run-statistics?**`, (route) =>
    route.fulfill({
      json: fixtureStatistics({
        window:
          new URL(route.request().url()).searchParams.get('window') ?? '24h',
        current: { running: 1 },
        byStatus: { running: 1, succeeded: 1 },
      }),
    }),
  );
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
