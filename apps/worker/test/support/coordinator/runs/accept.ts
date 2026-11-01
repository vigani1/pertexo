import { createHash, randomUUID } from 'node:crypto';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createWorkflowRunDatabase } from '@pertexo/core/runs';

import { createCheckpoint } from '@pertexo/workflow-engine';

import { coordinatorFixture } from '../consumer.js';
import { acceptManualFixtureRun } from '../../attempts/manual-start.js';
import {
  seedSerialForEachWorkflow,
  seedStructuredForEachWorkflow,
  type StructuredForEachKind,
} from '../workflows.js';
import {
  actorId,
  conditionWorkflowId,
  conditionWorkflowVersionId,
  databaseUrl,
  forEachWorkflowId,
  forEachWorkflowVersionId,
  apiUrl,
  nestedParallelWorkflowId,
  nestedParallelWorkflowVersionId,
  parallelWorkflowId,
  parallelWorkflowVersionId,
  switchWorkflowId,
  switchWorkflowVersionId,
  waitWorkflowId,
  waitWorkflowVersionId,
  workerQuery,
  workflowId,
  workflowVersionId,
  workspaceId,
} from './scope.js';
import type { AcceptedRun, AcceptedReplayRun } from './contract.js';

async function acceptFixtureRun(
  input: Readonly<{
    iterationBudget: number;
    workflowId: string;
    workflowVersionId: string;
  }>,
): Promise<AcceptedRun> {
  const checkpointInput = {
    workflowVersionId: input.workflowVersionId,
    iterationBudget: input.iterationBudget,
    nextEventSequence: 2,
  };
  return coordinatorFixture.apiDatabase.withWorkspace(
    workspaceId,
    (transaction) =>
      acceptManualFixtureRun(transaction, {
        initialCheckpoint: createCheckpoint(checkpointInput),
        keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
        operation: 'workflow.run.accept',
        runInput: input.workflowId === workflowId ? { name: 'Ada' } : {},
        requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
        scope: `workflow:${input.workflowId}:manual`,
        triggerType: 'manual',
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
      }),
  );
}

export function acceptRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 0,
    workflowId,
    workflowVersionId,
  });
}

export async function acceptReplayRun(): Promise<AcceptedReplayRun> {
  const source = await acceptRun();
  const database = createWorkflowRunDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(apiUrl),
      max: 2,
    }),
  );
  try {
    const accepted = await database.replay({
      actorId,
      workspaceId,
      sourceRunId: source.runId,
      workflowVersionId,
      idempotencyKeyHash: createHash('sha256')
        .update(randomUUID())
        .digest('hex'),
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `workflow:${source.runId}:replay`,
      input: { name: 'Replay' },
      checkpointFactory: (projection) => ({
        checkpoint: createCheckpoint({
          workflowVersionId: projection.id,
          iterationBudget: 0,
          nextEventSequence: 2,
        }),
      }),
    });
    const outboxRows = await workerQuery<{ id: string }>(
      `select id from app.outbox_events
        where workspace_id=$1 and aggregate_id=$2
          and job_name='advance-workflow-run'`,
      [workspaceId, accepted.run.id],
    );
    const outboxEventId = outboxRows[0]?.id;
    if (outboxEventId === undefined)
      throw new Error('replay coordinator outbox missing');
    return {
      outboxEventId,
      runId: accepted.run.id,
      sourceRunId: source.runId,
    };
  } finally {
    await database.close();
  }
}

export function acceptConditionRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 1_000,
    workflowId: conditionWorkflowId,
    workflowVersionId: conditionWorkflowVersionId,
  });
}

export function acceptSwitchRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 1_000,
    workflowId: switchWorkflowId,
    workflowVersionId: switchWorkflowVersionId,
  });
}

export function acceptParallelRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 1_000,
    workflowId: parallelWorkflowId,
    workflowVersionId: parallelWorkflowVersionId,
  });
}

export async function acceptSerialForEachRun(): Promise<AcceptedRun> {
  const identity = {
    workflowId: randomUUID(),
    workflowVersionId: randomUUID(),
  };
  await seedSerialForEachWorkflow(coordinatorFixture.ownerQuery, {
    actorId,
    workspaceId,
    identity,
  });
  return acceptFixtureRun({ ...identity, iterationBudget: 1_000 });
}

export async function acceptStructuredForEachRun(
  kind: StructuredForEachKind,
): Promise<AcceptedRun> {
  const identity = {
    workflowId: randomUUID(),
    workflowVersionId: randomUUID(),
  };
  await seedStructuredForEachWorkflow(coordinatorFixture.ownerQuery, {
    actorId,
    workspaceId,
    identity,
    kind,
  });
  return acceptFixtureRun({ ...identity, iterationBudget: 1_000 });
}

export function acceptForEachRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 1_000,
    workflowId: forEachWorkflowId,
    workflowVersionId: forEachWorkflowVersionId,
  });
}

export function acceptWaitRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 1_000,
    workflowId: waitWorkflowId,
    workflowVersionId: waitWorkflowVersionId,
  });
}

export function acceptNestedParallelRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 2,
    workflowId: nestedParallelWorkflowId,
    workflowVersionId: nestedParallelWorkflowVersionId,
  });
}
