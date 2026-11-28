import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  fixtureRun,
  fixtureTimestamp,
} from '../../../test/support/fixtures/run';
import type { Page } from '../../support/fixtures';
import { triageGraph } from '../../workspace/core-flow-invoice-graph';
import { installCoreFlowRoutes } from '../../workspace/core-flow-layout-fixture';
import { workflowId, workspaceId } from '../support';

export const task =
  'Draft a reply to the billing ticket using the order details.';

export async function installAgentRun(page: Page) {
  const base = triageGraph();
  const graph = {
    ...base,
    nodes: base.nodes.map((node) =>
      node.id === 'reply'
        ? {
            ...node,
            inputMappings: {
              prompt: { kind: 'literal' as const, value: task },
            },
          }
        : node,
    ),
  } satisfies WorkflowGraphContract;
  await installCoreFlowRoutes(page, { graph });
  const id = '20000000-0000-4000-8000-000000000101';
  const agentRunId = '20000000-0000-4000-8000-000000000102';
  const run = fixtureRun(id, 'succeeded', {
    workspaceId,
    workflowId,
    workflowName: 'Support triage',
  });
  await page.route('**/v1/workspaces/*/runs?**', (route) =>
    route.fulfill({ json: { items: [run], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/*/runs/${id}`, (route) =>
    route.fulfill({
      json: {
        run,
        nodes: [
          {
            id: agentRunId,
            nodeId: 'reply',
            invocationKey: 'reply',
            status: 'succeeded',
            currentAttemptNumber: 1,
            startedAt: fixtureTimestamp,
            completedAt: run.completedAt,
            resumeAt: null,
            safeErrorCode: null,
          },
        ],
      },
    }),
  );
  await page.route(
    `**/v1/workspaces/*/runs/${id}/node-runs/${agentRunId}/output`,
    (route) =>
      route.fulfill({
        json: {
          output: {
            kind: 'inline',
            value: { text: 'The refund was issued today.' },
          },
        },
      }),
  );
}
