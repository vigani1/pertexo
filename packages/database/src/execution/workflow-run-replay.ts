import { sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  lockExpectedCompatibilityReleaseSet,
  type CompatibilityReleaseExpectationSet,
} from '../compatibility/compatibility-release.js';
import { readWorkflowRunAcceptanceReplay } from './execution-acceptance.js';
import {
  classifyPublishedWorkflowVersionRow,
  type PublishedWorkflowV2Projection,
} from './published-workflow-reader.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
} from './workflow-run-errors.js';
import {
  acceptWorkflowRunWithAudit,
  requireWorkflowRunRecord,
} from './workflow-run-persistence-support.js';
import type { ReplayPublishedWorkflowRunInput } from './workflow-run-api.js';
import type { WorkflowRunRecord } from './workflow-run-persistence-support.js';

export async function replayWorkflowRunInTransaction(
  transaction: WorkspaceTransaction,
  input: ReplayPublishedWorkflowRunInput,
  compatibilityReleases: CompatibilityReleaseExpectationSet,
): Promise<Readonly<{ run: WorkflowRunRecord; replayed: boolean }>> {
  const identity = {
    keyHash: input.idempotencyKeyHash,
    operation: 'workflow.run.accept' as const,
    requestHash: input.requestHash,
    scope: input.scope,
  };
  const replay = await readWorkflowRunAcceptanceReplay(transaction, identity);
  if (replay !== null) {
    const run = await requireWorkflowRunRecord(transaction, replay.runId);
    return Object.freeze({ run, replayed: true });
  }

  const currentCompatibilityRelease = await lockExpectedCompatibilityReleaseSet(
    transaction.db,
    compatibilityReleases,
  );
  const source = await lockReplaySource(transaction, input.sourceRunId);
  const projection = await lockReplayVersion(
    transaction,
    source.workflowId,
    input.workflowVersionId,
  );
  const initial = input.checkpointFactory(
    projection,
    currentCompatibilityRelease,
  );
  return acceptWorkflowRunWithAudit(transaction, {
    acceptance: {
      engineVersion: initial.engineVersion,
      initialCheckpoint: initial.checkpoint,
      keyHash: input.idempotencyKeyHash,
      operation: 'workflow.run.accept',
      requestHash: input.requestHash,
      replayCommandId: generatePersistedId(),
      replaySourceRunId: input.sourceRunId,
      runInput: input.input,
      scope: input.scope,
      triggerType: 'replay',
      workflowId: source.workflowId,
      workflowVersionId: projection.id,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    },
    actorId: input.actorId,
    auditAction: 'workflow.run.replayed',
    auditMetadata: sql`jsonb_build_object('schemaVersion', 1, 'sourceRunId', ${input.sourceRunId}::text, 'workflowId', ${source.workflowId}::text, 'workflowVersionId', ${projection.id}::text)`,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  });
}

async function lockReplaySource(
  transaction: WorkspaceTransaction,
  sourceRunId: string,
): Promise<Readonly<{ workflowId: string }>> {
  const result = await transaction.db.execute<{
    workflow_id: string;
    lifecycle_status: string;
  }>(sql`
    select workflow_id, lifecycle_status
    from app.lock_workflow_run_replay_source(
      ${transaction.workspaceId}, ${sourceRunId}
    )
  `);
  const source = result.rows[0];
  if (source === undefined) throw new WorkflowRunNotFoundError();
  if (source.lifecycle_status !== 'active')
    throw new WorkflowRunNotExecutableError();
  return Object.freeze({ workflowId: z.uuid().parse(source.workflow_id) });
}

async function lockReplayVersion(
  transaction: WorkspaceTransaction,
  workflowId: string,
  workflowVersionId: string,
): Promise<PublishedWorkflowV2Projection> {
  const result = await transaction.db.execute(sql<Record<string, unknown>>`
    select
      id,
      workspace_id,
      workflow_id,
      version_number,
      schema_version,
      checksum,
      executable_schema_version,
      executable_json,
      compatibility_release_epoch
    from app.lock_workflow_run_replay_version(
      ${transaction.workspaceId}, ${workflowId}, ${workflowVersionId}
    )
  `);
  const classified = classifyPublishedWorkflowVersionRow(result.rows[0]);
  if (classified.kind === 'not_found') throw new WorkflowRunNotFoundError();
  if (classified.kind !== 'v2_projection')
    throw new WorkflowRunNotExecutableError();
  if (
    classified.workflowVersion.workflowId !== workflowId ||
    classified.workflowVersion.workspaceId !== transaction.workspaceId
  )
    throw new WorkflowRunNotFoundError();
  return classified.workflowVersion;
}
