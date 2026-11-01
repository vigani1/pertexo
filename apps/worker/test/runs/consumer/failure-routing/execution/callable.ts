import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { initialCheckpointFactory } from '@pertexo/core/execution';

import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import type { WorkflowGraph } from '@pertexo/workflow-model';

import { coordinatorFixture as fixture } from '../../../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../../../support/coordinator/workflows.js';
import { graph } from '../fixture.js';
import type { RoutingScenario } from './contract.js';
import type { openRoutedRun } from './pending.js';

export async function assertCallableAndRetention(
  scenario: RoutingScenario,
  first: Awaited<ReturnType<typeof openRoutedRun>>,
) {
  const { control, runs, catalog, wait } = scenario;
  control.mode = 'handled';
  const callableGraph: WorkflowGraph = {
    ...graph(),
    callable: {
      input: { type: 'object', properties: [] },
      resultType: { type: 'object', properties: [] },
      result: { kind: 'node_output', nodeId: 'source', path: '$' },
    },
  };
  const callableWorkflowId = randomUUID(),
    callableVersionId = randomUUID();
  await insertCompiledWorkflow(fixture.ownerQuery, {
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    identity: {
      workflowId: callableWorkflowId,
      workflowVersionId: callableVersionId,
    },
    graph: callableGraph,
    name: 'No invented callable result',
    catalog: PLATFORM_NODE_CATALOG,
  });
  await fixture.ownerQuery(
    'update app.workflows set published_version_id=$2 where id=$1',
    [callableWorkflowId, callableVersionId],
  );
  const callableKey = createHash('sha256').update(randomUUID()).digest('hex');
  const callableRun = await runs.start({
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    workflowId: callableWorkflowId,
    idempotencyKeyHash: callableKey,
    requestHash: callableKey,
    scope: `workflow:${callableWorkflowId}:manual`,
    input: {},
    checkpointFactory: initialCheckpointFactory({ catalog }),
  });
  await wait(callableRun.run.id, 'failed');
  expect(
    (
      await runs.get({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: callableRun.run.id,
      })
    )?.run.handledFailureCount,
  ).toBe(1);
  const callableList = await runs.list({
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    workflowId: callableWorkflowId,
    limit: 10,
  });
  expect(callableList.items[0]?.failedStep).toBeNull();
  const inbox = await fixture.ownerQuery<{ count: number }>(
    'select count(*)::int count from app.workspace_inbox_events where run_id=$1',
    [first.run.id],
  );
  expect(inbox[0]?.count).toBe(0);
  // Detail retirement removes source evidence; the run still explains its success.
  await fixture.ownerQuery(
    'delete from app.run_events where workflow_run_id=$1',
    [first.run.id],
  );
  await fixture.ownerQuery(
    'delete from app.node_runs where workflow_run_id=$1',
    [first.run.id],
  );
  expect(
    (
      await runs.get({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: first.run.id,
      })
    )?.run.handledFailureCount,
  ).toBe(1);
}
