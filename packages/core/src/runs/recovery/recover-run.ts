import { requireWorkflowRun } from '../workflow-run.errors.js';
import { lockWorkspaceRunAdmission } from '../../shared/workspace-fence.repository.js';
import { copyRecoveryRunValues } from '../values/rows.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { generatePersistedId } from '@pertexo/database/platform';
import { insertReusedNodeRuns } from './reused-nodes.repository.js';
import {
  missingRecoveryAcknowledgement,
  recoveryEffectsAcknowledged,
} from './acknowledgement.js';
import { readRecoveryEvidence } from './read-evidence.js';
import { WorkflowRecoveryUnavailableError } from './workflow-recovery.errors.js';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
} from '../commands/acceptance/accept.js';
import { readWorkflowRunAcceptanceReplay } from '../commands/acceptance/read-replay.js';
import {
  insertWorkflowRunAudit,
  readWorkflowRunRecord,
} from '../commands/workflow-run-records.repository.js';
import { lockRunAcceptanceCommand } from '../commands/acceptance/lock.repository.js';
import type { RecoverPublishedWorkflowRunInput } from '../commands/run-commands.types.js';

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
      run: requireWorkflowRun(
        await readWorkflowRunRecord(transaction, replay.runId),
      ),
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
        effectsAcknowledged: recoveryEffectsAcknowledged(
          preview.effectRisk,
          input,
        ),
      },
    },
  );
  if (accepted.duplicate)
    return {
      run: requireWorkflowRun(
        await readWorkflowRunRecord(transaction, accepted.runId),
      ),
      replayed: true,
    };
  if (seed.copies.length > 0) {
    await copyRecoveryRunValues(transaction, input.sourceRunId, accepted.runId);
    await insertReusedNodeRuns(transaction, accepted.runId, seed.copies);
  }
  await insertWorkflowRunAudit(transaction, {
    action: 'workflow.run.recovered',
    actorId: input.actorId,
    runId: accepted.runId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    metadata: {
      sourceRunId: input.sourceRunId,
      workflowId: metadata.run.workflowId,
      workflowVersionId: metadata.run.workflowVersionId,
      targetNodeRunId: preview.nodeRunId,
      targetNodeId: preview.nodeId,
      reusedCount: preview.reusedCount,
      effectRisk: preview.effectRisk,
      acknowledgePossibleEffects: input.acknowledgePossibleEffects ?? false,
      acknowledgeUnknownOutcome: input.acknowledgeUnknownOutcome ?? false,
    },
  });
  return {
    run: requireWorkflowRun(
      await readWorkflowRunRecord(transaction, accepted.runId),
    ),
    replayed: false,
  };
}

async function prepareRecoveryEvidence(
  transaction: WorkspaceTransaction,
  input: RecoverWorkflowRunInput,
) {
  // Same order as coordinator writes: workspace, source run/details, then admission counter.
  await lockWorkspaceRunAdmission(transaction.db, transaction.workspaceId);
  const evidence = await readRecoveryEvidence(transaction, {
    runId: input.sourceRunId,
    mode: 'locked',
    prepareRecovery: input.prepareRecovery,
    workflowVersionId: input.workflowVersionId,
  });
  if (evidence.kind === 'refused')
    throw new WorkflowRecoveryUnavailableError(evidence.reason);
  const { metadata, candidate, prepared } = evidence;
  const preview = prepared.preview;
  if (preview.nodeRunId !== input.nodeRunId)
    throw new WorkflowRecoveryUnavailableError('evidence_unavailable');
  const missing = missingRecoveryAcknowledgement(preview.effectRisk, input);
  if (missing !== undefined)
    throw new WorkflowRecoveryUnavailableError(missing);
  const identity = allocateRecoveryIdentity(candidate.nodeRunIds);
  const seed = prepared.seed(identity);
  if (seed.kind === 'refused')
    throw new WorkflowRecoveryUnavailableError(seed.reason);

  return { metadata, prepared, preview, identity, seed };
}
