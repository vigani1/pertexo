import { expect } from 'vitest';

import { createCoordinatorRuntime } from '../../../../../dist/runs/runtime.js';

import { coordinatorFixture as fixture } from '../../../../support/coordinator/consumer.js';

import type { RoutingScenario } from './contract.js';
import type { openRoutedRun } from './pending.js';

export async function resumeHandledRun(
  scenario: RoutingScenario,
  first: Awaited<ReturnType<typeof openRoutedRun>>,
) {
  const {
    live,
    coordinatorConfig,
    releaseHandler,
    wait,
    runs,
    executed,
    workflowId,
  } = scenario;
  await live.coordinator.close();
  live.coordinator = await createCoordinatorRuntime(coordinatorConfig);
  await live.coordinator.consumer.waitUntilReady(5_000);
  releaseHandler();
  await wait(first.run.id, 'succeeded');
  const finished = await runs.get({
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    runId: first.run.id,
  });
  expect(finished?.run.handledFailureCount).toBe(1);
  expect(finished?.nodes.find((n) => n.nodeId === 'source')).toMatchObject({
    status: 'failed',
    failureHandling: { disposition: 'handled' },
  });
  expect(finished?.nodes.find((n) => n.nodeId === 'normal-stop')?.status).toBe(
    'skipped',
  );
  expect(finished?.nodes.find((n) => n.nodeId === 'off-path')?.status).toBe(
    'skipped',
  );
  expect(
    finished?.nodes.find((n) => n.nodeId === 'handler')?.invocationKey,
  ).toContain('choice');
  expect(
    executed.filter((n) => n.runId === first.run.id).map((n) => n.nodeId),
  ).toEqual(['manual', 'choice', 'source', 'handler', 'handler-stop']);
  const events = await fixture.workerQuery<{ type: string }>(
    'select type from app.run_events where workflow_run_id=$1 order by sequence',
    [first.run.id],
  );
  expect(events.filter((e) => e.type === 'node.failure_routed')).toHaveLength(
    1,
  );
  expect(events.filter((e) => e.type === 'node.failure_handled')).toHaveLength(
    1,
  );
  const health = await runs.stepHealth({
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    workflowId,
  });
  expect(health?.items.find((step) => step.nodeId === 'source')).toMatchObject({
    runs: 1,
    failed: 1,
    lastStatus: 'failed',
  });
  const summaries = await runs.list({
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    workflowId,
    limit: 10,
  });
  expect(
    summaries.items.find((r) => r.id === first.run.id)?.handledFailureCount,
  ).toBe(1);
}
