import {
  readRecoveryCheckpoint,
  readRecoveryNodes,
  readRecoveryAttempts,
  recoveryOutputs,
  recoverySize,
} from './snapshot.queries.js';
import {
  workflows,
  workflowVersions,
} from '../../schema/authoring/workflows.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  WORKFLOW_GRAPH_LIMITS,
  WORKFLOW_RECOVERY_LIMITS,
} from '@pertexo/workflow-model';
import type {
  RecoveryNode,
  RecoveryRefused,
  RecoveryValues,
} from '@pertexo/workflow-engine';
import { branchContextSchema } from '../../attempts/validation/shared.js';
import {
  StoredExecutionValueInvalidError,
  type StoredExecutionValue,
  parseStoredExecutionValue,
} from '../../platform/stored-execution-value.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
} from '../errors.js';
import { readWorkflowRunRecord } from '../commands/records.repository.js';
import {
  lockReplaySource,
  lockReplayVersion,
} from '../commands/replay.repository.js';
import type {
  WorkflowRecoveryMetadata,
  WorkflowRecoveryPreparation,
} from './contract.js';
import {
  readWorkflowRunFailedSteps,
  runInputInTransaction,
} from '../queries/history/details.queries.js';

const maximumAttemptRecords = 1_000;

const refused = (reason: RecoveryRefused['reason']) =>
  ({ kind: 'refused', reason }) as const;

/**
 * The evidence chain a recovery preview and its acceptance share, so a preview
 * offers only what acceptance would take. Acceptance names the version it was
 * offered; a preview reads whichever the run has.
 */
export async function readRecoveryEvidence(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    runId: string;
    mode: 'snapshot' | 'locked';
    prepareRecovery: WorkflowRecoveryPreparation;
    workflowVersionId?: string;
  }>,
) {
  const metadata = await readRecoveryMetadata(
    transaction,
    input.runId,
    input.mode,
  );
  if ('kind' in metadata) return metadata;
  if (
    input.workflowVersionId !== undefined &&
    metadata.run.workflowVersionId !== input.workflowVersionId
  )
    return refused('version_unavailable');
  const candidate = input.prepareRecovery(metadata);
  if (candidate.kind === 'refused') return candidate;
  const values = await readRecoveryValues(
    transaction,
    input.runId,
    candidate.nodeRunIds,
  );
  if ('kind' in values) return values;
  const prepared = candidate.complete(values);
  if (prepared.kind === 'refused') return prepared;
  return { kind: 'ready' as const, metadata, candidate, prepared };
}

/** Snapshot reads never reserve; command reads hold source details against retirement. */
async function readRecoveryMetadata(
  transaction: WorkspaceTransaction,
  runId: string,
  mode: 'snapshot' | 'locked',
): Promise<WorkflowRecoveryMetadata | RecoveryRefused> {
  try {
    if (mode === 'locked') await lockReplaySource(transaction, runId);
    const run = await readWorkflowRunRecord(transaction, runId);
    if (run === undefined) throw new WorkflowRunNotFoundError();
    if (run.status !== 'failed' && run.status !== 'outcome_unknown')
      return { kind: 'refused', reason: 'source_not_failed' };
    const workflow =
      mode === 'locked'
        ? await lockReplayVersion(
            transaction,
            run.workflowId,
            run.workflowVersionId,
          )
        : await readVersion(transaction, run.workflowId, run.workflowVersionId);
    const [checkpoint] = await readRecoveryCheckpoint(transaction, runId, mode);
    if (checkpoint === undefined)
      return { kind: 'refused', reason: 'values_expired' };
    const rows = await readRecoveryNodes(transaction, runId, mode);
    if (rows.length > WORKFLOW_GRAPH_LIMITS.nodes)
      return { kind: 'refused', reason: 'unsupported_graph' };
    const parsed = rows.map((row) => ({
      ...row,
      branch_context: branchContextSchema.parse(row.branch_context),
    }));
    const attempts = await readRecoveryAttempts(
      transaction,
      parsed.map((node) => node.id),
      mode,
    );
    if (attempts.length > maximumAttemptRecords)
      return { kind: 'refused', reason: 'reuse_bounds' };
    const attemptsByNode = new Map<
      string,
      RecoveryNode['attempts'][number][]
    >();
    for (const row of attempts) {
      const list = attemptsByNode.get(row.node_run_id) ?? [];
      list.push({
        id: row.id,
        number: row.attempt_number,
        status: row.status,
        failureKind: row.executor_failure_kind,
        errorKind: row.executor_error_kind,
        possiblyDispatched: row.executor_possibly_dispatched,
        dispatchMarked: row.dispatch_marked,
        retryDecision: row.retry_decision,
      });
      attemptsByNode.set(row.node_run_id, list);
    }
    const nodes: RecoveryNode[] = parsed.map((node) => {
      const {
        reused_source_run_id,
        reused_source_node_run_id,
        reused_source_completed_at,
      } = node;
      const incompleteReusedSource =
        reused_source_run_id === null ||
        reused_source_node_run_id === null ||
        reused_source_completed_at === null;
      return {
        id: node.id,
        nodeId: node.node_id,
        invocationKey: node.invocation_key,
        status: node.status,
        sideEffectClass: node.side_effect_class,
        currentAttemptId: node.current_attempt_id,
        currentAttemptNumber: node.current_attempt_number,
        completedAt: node.completed_at?.toISOString() ?? null,
        ...(node.branch_context.branchPath === undefined
          ? {}
          : { branchPath: node.branch_context.branchPath }),
        ...(node.branch_context.iterationPath === undefined
          ? {}
          : { iterationPath: node.branch_context.iterationPath }),
        ...(incompleteReusedSource
          ? {}
          : {
              reused: {
                sourceRunId: reused_source_run_id,
                sourceNodeRunId: reused_source_node_run_id,
                completedAt: reused_source_completed_at.toISOString(),
              },
            }),
        attempts: attemptsByNode.get(node.id) ?? [],
      };
    });
    const failedStep = (
      await readWorkflowRunFailedSteps(transaction, [runId])
    ).get(runId);
    return {
      run,
      workflow,
      checkpoint: checkpoint.scheduler_state,
      nodes,
      failedStep:
        failedStep === undefined
          ? undefined
          : { nodeId: failedStep.nodeId, label: failedStep.label },
    };
  } catch (error) {
    if (error instanceof WorkflowRunNotExecutableError)
      return { kind: 'refused', reason: 'version_unavailable' };
    if (error instanceof z.ZodError)
      return { kind: 'refused', reason: 'evidence_unavailable' };
    throw error;
  }
}

async function readVersion(
  transaction: WorkspaceTransaction,
  workflowId: string,
  versionId: string,
) {
  const [row] = await transaction.db
    .select({
      status: workflows.lifecycleStatus,
      workflow: {
        checksum: workflowVersions.checksum,
        executableJson: workflowVersions.executableJson,
        id: workflowVersions.id,
        versionNumber: workflowVersions.versionNumber,
        workflowId: workflowVersions.workflowId,
        workspaceId: workflowVersions.workspaceId,
      },
    })
    .from(workflowVersions)
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, workflowVersions.workspaceId),
        eq(workflows.id, workflowVersions.workflowId),
      ),
    )
    .where(
      and(
        eq(workflowVersions.workspaceId, transaction.workspaceId),
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.id, versionId),
      ),
    );
  if (row === undefined) throw new WorkflowRunNotFoundError();
  if (row.status !== 'active') throw new WorkflowRunNotExecutableError();
  return Object.freeze(row.workflow);
}

async function readRecoveryValues(
  transaction: WorkspaceTransaction,
  runId: string,
  nodeRunIds: readonly string[],
): Promise<RecoveryValues | RecoveryRefused> {
  const [size] = await recoverySize(transaction, runId, nodeRunIds);
  if (Number(size?.bytes ?? 0) > WORKFLOW_RECOVERY_LIMITS.storageBytes)
    return { kind: 'refused', reason: 'reuse_bounds' };
  try {
    const input = await runInputInTransaction(transaction, runId);
    if (input === undefined) throw new WorkflowRunNotFoundError();
    const rows = await recoveryOutputs(transaction, runId, nodeRunIds);
    const outputs = new Map<
      string,
      {
        node: StoredExecutionValue | undefined;
        attempt: StoredExecutionValue | undefined;
      }
    >();
    for (const row of rows)
      outputs.set(row.id, {
        node:
          row.node_output === null
            ? undefined
            : parseStoredExecutionValue(row.node_output),
        attempt:
          row.attempt_output === null
            ? undefined
            : parseStoredExecutionValue(row.attempt_output),
      });
    return { input, outputs };
  } catch (error) {
    if (error instanceof StoredExecutionValueInvalidError)
      return { kind: 'refused', reason: 'evidence_unavailable' };
    throw error;
  }
}
