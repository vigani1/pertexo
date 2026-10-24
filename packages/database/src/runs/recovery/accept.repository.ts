import { copyRecoveryRunValues } from '../values/records.queries.js';
import { sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { prepareStoredExecutionValue } from '../../platform/stored-execution-value.js';
import { nodeRuns, runEvents } from '../../schema/runs/execution.js';
import { readRecoveryMetadata, readRecoveryValues } from './records.queries.js';
import { WorkflowRecoveryUnavailableError } from './contract.js';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
  readWorkflowRunAcceptanceReplay,
} from '../commands/acceptance.repository.js';
import {
  insertWorkflowRunAudit,
  requireWorkflowRunRecord,
} from '../commands/records.repository.js';
import { lockRunAcceptanceCommand } from '../commands/lock-acceptance.repository.js';
import type { RecoverPublishedWorkflowRunInput } from '../runs.repository.js';

export type RecoverWorkflowRunInput = RecoverPublishedWorkflowRunInput;

export function allocateRecoveryIdentity(nodeRunIds: readonly string[]) {
  return {
    runId: generatePersistedId(),
    nodeRunIds: new Map(nodeRunIds.map((id) => [id, generatePersistedId()])),
  };
}

export async function recoverWorkflowRunInTransaction(
  transaction: WorkspaceTransaction,
  input: RecoverWorkflowRunInput,
) {
  await lockRunAcceptanceCommand(transaction, input);
  const replay = await readWorkflowRunAcceptanceReplay(transaction, {
    operation: 'workflow.run.accept',
    scope: input.scope,
    keyHash: input.idempotencyKeyHash,
    requestHash: input.requestHash,
  });
  if (replay !== null)
    return {
      run: await requireWorkflowRunRecord(transaction, replay.runId),
      replayed: true,
    };
  const { metadata, prepared, preview, identity, seed } =
    await prepareRecoveryEvidence(transaction, input);
  const acceptance = await prepareWorkflowRunAcceptance(
    transaction,
    metadata.run.workflowId,
  );
  const accepted = await acceptWorkflowRun(
    transaction,
    {
      initialCheckpoint: seed.checkpoint,
      operation: 'workflow.run.accept',
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      scope: input.scope,
      replayCommandId: generatePersistedId(),
      replaySourceRunId: input.sourceRunId,
      triggerType: 'replay',
      startedBy: input.actorId,
      workflowId: metadata.run.workflowId,
      workflowVersionId: metadata.run.workflowVersionId,
      ...(prepared.input === undefined ? {} : { runInput: prepared.input }),
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    },
    {
      ...acceptance,
      runId: identity.runId,
      recovery: {
        targetNodeRunId: preview.nodeRunId,
        targetNodeId: preview.nodeId,
        reusedCount: preview.reusedCount,
        effectRisk: preview.effectRisk,
        effectsAcknowledged:
          preview.effectRisk === 'unknown_outcome'
            ? (input.acknowledgeUnknownOutcome ?? false)
            : (input.acknowledgePossibleEffects ?? false),
      },
    },
  );
  if (accepted.duplicate)
    return {
      run: await requireWorkflowRunRecord(transaction, accepted.runId),
      replayed: true,
    };
  if (seed.copies.length > 0) {
    await copyRecoveryRunValues(transaction, input.sourceRunId, accepted.runId);
    await transaction.db.insert(nodeRuns).values(
      seed.copies.map((copy) => ({
        id: copy.id,
        workspaceId: transaction.workspaceId,
        workflowRunId: accepted.runId,
        nodeId: copy.nodeId,
        invocationKey: copy.invocationKey,
        status: 'succeeded',
        sideEffectClass: copy.sideEffectClass,
        ...(copy.providerIdempotencyKey === undefined
          ? {}
          : { providerIdempotencyKey: copy.providerIdempotencyKey }),
        branchContext:
          copy.branchPath === undefined ? {} : { branchPath: copy.branchPath },
        outputRef: sql`${prepareStoredExecutionValue({ kind: 'inline', value: copy.value }).json}::json`,
        reusedSourceRunId: copy.sourceRunId,
        reusedSourceNodeRunId: copy.sourceNodeRunId,
        reusedSourceCompletedAt: new Date(copy.sourceCompletedAt),
      })),
    );
    await transaction.db.insert(runEvents).values(
      seed.copies.map((copy, index) => ({
        workspaceId: transaction.workspaceId,
        workflowRunId: accepted.runId,
        sequence: index + 2,
        type: 'node.reused',
        payload: {
          nodeId: copy.nodeId,
          nodeRunId: copy.id,
          outputRef: { kind: 'reused', nodeRunId: copy.id },
          invocationKey: copy.invocationKey,
          sourceRunId: copy.sourceRunId,
          sourceNodeRunId: copy.sourceNodeRunId,
          sourceCompletedAt: copy.sourceCompletedAt,
        },
      })),
    );
  }
  await insertWorkflowRunAudit(transaction, {
    action: 'workflow.run.recovered',
    actorId: input.actorId,
    runId: accepted.runId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    metadata: sql`jsonb_build_object('sourceRunId',${input.sourceRunId}::text,
      'workflowId',${metadata.run.workflowId}::text,'workflowVersionId',${metadata.run.workflowVersionId}::text,
      'targetNodeRunId',${preview.nodeRunId}::text,'targetNodeId',${preview.nodeId}::text,
      'reusedCount',${preview.reusedCount}::integer,'effectRisk',${preview.effectRisk}::text,
      'acknowledgePossibleEffects',${input.acknowledgePossibleEffects ?? false}::boolean,
      'acknowledgeUnknownOutcome',${input.acknowledgeUnknownOutcome ?? false}::boolean)`,
  });
  return {
    run: await requireWorkflowRunRecord(transaction, accepted.runId),
    replayed: false,
  };
}

async function prepareRecoveryEvidence(
  transaction: WorkspaceTransaction,
  input: RecoverWorkflowRunInput,
) {
  // Same order as coordinator writes: workspace, source run/details, then admission counter.
  await transaction.db.execute(
    sql`select app.lock_workspace_run_admission(${transaction.workspaceId})`,
  );
  const metadata = await readRecoveryMetadata(
    transaction,
    input.sourceRunId,
    'locked',
  );
  if ('kind' in metadata)
    throw new WorkflowRecoveryUnavailableError(metadata.reason);
  if (metadata.run.workflowVersionId !== input.workflowVersionId)
    throw new WorkflowRecoveryUnavailableError('version_unavailable');
  const candidate = input.prepareRecovery(metadata);
  if (candidate.kind === 'refused')
    throw new WorkflowRecoveryUnavailableError(candidate.reason);
  const values = await readRecoveryValues(
    transaction,
    input.sourceRunId,
    candidate.nodeRunIds,
  );
  if ('kind' in values)
    throw new WorkflowRecoveryUnavailableError(values.reason);
  const prepared = candidate.complete(values);
  if (prepared.kind === 'refused')
    throw new WorkflowRecoveryUnavailableError(prepared.reason);
  const preview = prepared.preview;
  if (preview.nodeRunId !== input.nodeRunId)
    throw new WorkflowRecoveryUnavailableError('evidence_unavailable');
  if (
    preview.effectRisk === 'possible_effects' &&
    !(input.acknowledgePossibleEffects ?? false)
  )
    throw new WorkflowRecoveryUnavailableError(
      'effects_acknowledgement_required',
    );
  if (
    preview.effectRisk === 'unknown_outcome' &&
    !(input.acknowledgeUnknownOutcome ?? false)
  )
    throw new WorkflowRecoveryUnavailableError(
      'unknown_outcome_acknowledgement_required',
    );
  const identity = allocateRecoveryIdentity(candidate.nodeRunIds);
  const seed = prepared.seed(identity);
  if (seed.kind === 'refused')
    throw new WorkflowRecoveryUnavailableError(seed.reason);

  return { metadata, prepared, preview, identity, seed };
}
