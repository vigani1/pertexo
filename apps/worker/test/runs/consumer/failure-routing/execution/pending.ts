import { expect } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutable,
  parseCheckpoint,
} from '@pertexo/workflow-engine';

import { coordinatorFixture as fixture } from '../../../../support/coordinator/consumer.js';

import { graph } from '../fixture.js';
import type { RoutingScenario } from './contract.js';

export async function openRoutedRun(scenario: RoutingScenario) {
  const { start, executed, runs, workflowVersionId, catalog } = scenario;
  const first = await start();
  await fixture.waitFor(
    () =>
      Promise.resolve(
        executed.some(
          (n) => n.runId === first.run.id && n.nodeId === 'handler',
        ),
      ),
    (entered) => entered,
  );
  const pending = await runs.get({
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    runId: first.run.id,
  });
  const source = pending?.nodes.find((n) => n.nodeId === 'source');
  expect(source).toMatchObject({
    status: 'failed',
    currentAttemptNumber: 1,
    failureHandling: { disposition: 'pending' },
  });
  expect(pending?.run.status).toBe('running');
  const evidence = (
    await fixture.workerQuery<{ failure_ref: unknown }>(
      'select failure_ref from app.node_runs where workflow_run_id=$1 and node_id=$2',
      [first.run.id, 'source'],
    )
  )[0]?.failure_ref;
  expect(evidence).toEqual({
    kind: 'inline',
    value: {
      nodeId: 'source',
      invocationKey: source?.invocationKey,
      attemptNumber: 1,
      errorKind: 'authentication',
      safeErrorCode: 'execution.authentication',
    },
  });
  expect(
    executed.find((n) => n.runId === first.run.id && n.nodeId === 'handler')
      ?.input,
  ).toEqual({ failure: (evidence as { value: unknown }).value });
  const checkpointRow = (
    await fixture.workerQuery<{ scheduler_state: unknown }>(
      'select scheduler_state from app.run_checkpoints where workflow_run_id=$1',
      [first.run.id],
    )
  )[0];
  const restored = parseCheckpoint(checkpointRow?.scheduler_state);
  const corrupted = {
    ...restored,
    branchSelections: restored.branchSelections.map((selection) => ({
      ...selection,
      selectedOutputPort: 'false',
    })),
  };
  await expect(
    advanceWorkflow({
      runId: first.run.id,
      workflowVersionId,
      executable: buildWorkflowExecutable({ graph: graph(), catalog }),
      checkpoint: corrupted,
      occurredAt: new Date().toISOString(),
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });

  return first;
}
