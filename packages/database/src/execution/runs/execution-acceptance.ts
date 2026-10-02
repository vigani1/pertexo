import { and, eq, sql } from 'drizzle-orm';
import { idempotencyRecords, workflowRuns } from '../../schema.js';
import { serializeStoredExecutionValueV1 } from '../stored-execution-value.js';
import { resolveWorkflowFailureNotificationPolicy } from '../notifications/failure-notification-policy.js';
import type { WorkspaceTransaction } from '../../tenant-access/workspace.js';
import { prepareWorkflowRunAcceptanceInput } from './execution-acceptance-input.js';
import { persistWorkflowRunAcceptance } from './execution-acceptance-persistence.js';
import {
  allocateWorkflowRunAcceptanceIdentifiers,
  claimWorkflowRunAcceptance,
} from './execution-acceptance-claim.js';
import {
  acceptCanonicalWorkflowCallRun,
  acceptWorkflowCallRunInputSchema,
  type AcceptWorkflowCallRunInput,
} from './workflow-call-acceptance.js';
import { z } from 'zod';
import {
  acceptWorkflowRunInputSchema,
  acceptanceReplayInputSchema,
  resultRefSchema,
  workflowRunStatusSchema,
  IDEMPOTENCY_STATUS,
  IdempotencyRecordCorruptError,
  IdempotencyRequestConflictError,
  WorkspaceRunAdmissionDeniedError,
  throwWorkflowRunAdmissionError,
  type AcceptWorkflowRunInput,
  type AcceptedWorkflowRun,
  type ParsedAcceptWorkflowRunInput,
  type WorkflowRunAcceptanceReplayInput,
} from './execution-acceptance-contract.js';
export {
  RUN_STATUS,
  RUN_STATUS_VALUES,
  IDEMPOTENCY_STATUS,
  IDEMPOTENCY_STATUS_VALUES,
  IdempotencyRequestConflictError,
  IdempotencyRecordCorruptError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
  RegionalWriteAdmissionPausedError,
  throwWorkflowRunAdmissionError,
  type RunStatus,
  type IdempotencyStatus,
  type AcceptWorkflowRunInput,
  type AcceptedWorkflowRun,
  type WorkflowRunAcceptanceReplayInput,
} from './execution-acceptance-contract.js';

async function assertWorkspaceAcceptsNewRuns(
  transaction: WorkspaceTransaction,
): Promise<void> {
  const result = await transaction.db.execute<{ status: string }>(sql`
    select app.lock_workspace_run_admission(${transaction.workspaceId}) status
  `);

  if (result.rows[0]?.status !== 'active') {
    throw new WorkspaceRunAdmissionDeniedError();
  }
}

type ReplayValidation =
  | Readonly<{ kind: 'request_only' }>
  | Readonly<{ kind: 'exact_initial_checkpoint'; hash: string }>;

async function readExistingAcceptance(
  transaction: WorkspaceTransaction,
  input: Pick<
    ParsedAcceptWorkflowRunInput,
    'keyHash' | 'operation' | 'requestHash' | 'scope'
  >,
  replayValidation: ReplayValidation,
): Promise<AcceptedWorkflowRun | null> {
  const rows = await transaction.db
    .select({
      requestHash: idempotencyRecords.requestHash,
      resourceId: idempotencyRecords.resourceId,
      resultRef: idempotencyRecords.resultRef,
      idempotencyStatus: idempotencyRecords.status,
      acceptedAt: workflowRuns.createdAt,
      runStatus: workflowRuns.status,
    })
    .from(idempotencyRecords)
    .leftJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, idempotencyRecords.workspaceId),
        eq(workflowRuns.id, idempotencyRecords.resourceId),
      ),
    )
    .where(
      and(
        eq(idempotencyRecords.workspaceId, transaction.workspaceId),
        eq(idempotencyRecords.operation, input.operation),
        eq(idempotencyRecords.scope, input.scope),
        eq(idempotencyRecords.keyHash, input.keyHash),
      ),
    )
    .limit(1);
  const row = rows[0];

  if (row === undefined) {
    return null;
  }
  if (row.requestHash !== input.requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  const resultRef = resultRefSchema.safeParse(row.resultRef);
  const runStatus = workflowRunStatusSchema.safeParse(row.runStatus);
  if (
    row.idempotencyStatus !== IDEMPOTENCY_STATUS.completed ||
    row.acceptedAt === null ||
    !resultRef.success ||
    !runStatus.success
  ) {
    throw new IdempotencyRecordCorruptError();
  }
  if (
    replayValidation.kind === 'exact_initial_checkpoint' &&
    resultRef.data.initialCheckpointHash !== replayValidation.hash
  ) {
    throw new IdempotencyRequestConflictError();
  }

  return Object.freeze({
    acceptedAt: row.acceptedAt,
    duplicate: true,
    outboxEventId: resultRef.data.outboxEventId,
    runId: row.resourceId,
    status: runStatus.data,
  });
}

/** Resolve a completed exact request replay before reading current workflow state. */
export async function readWorkflowRunAcceptanceReplay(
  transaction: WorkspaceTransaction,
  input: WorkflowRunAcceptanceReplayInput,
): Promise<AcceptedWorkflowRun | null> {
  const parsed = acceptanceReplayInputSchema.parse(input);
  return readExistingAcceptance(transaction, parsed, { kind: 'request_only' });
}

export async function acceptWorkflowRun(
  transaction: WorkspaceTransaction,
  input: AcceptWorkflowRunInput | AcceptWorkflowCallRunInput,
): Promise<AcceptedWorkflowRun> {
  const parsed = z
    .union([acceptWorkflowRunInputSchema, acceptWorkflowCallRunInputSchema])
    .parse(input);
  if (parsed.triggerType === 'workflow_call')
    return acceptCanonicalWorkflowCallRun(transaction, parsed);
  const storedRunInputJson =
    parsed.runInput === undefined
      ? null
      : serializeStoredExecutionValueV1({
          schemaVersion: 1,
          kind: 'inline',
          value: parsed.runInput,
        });
  const { initialCheckpointJson, initialCheckpointHash } =
    prepareWorkflowRunAcceptanceInput(parsed);
  const existing = await readExistingAcceptance(transaction, parsed, {
    kind: 'exact_initial_checkpoint',
    hash: initialCheckpointHash,
  });
  if (existing !== null) return existing;

  try {
    await transaction.db.execute(
      sql`select app.assert_regional_write_admission()`,
    );
    await assertWorkspaceAcceptsNewRuns(transaction);
  } catch (error: unknown) {
    throwWorkflowRunAdmissionError(error);
  }
  const failureNotificationPolicy =
    await resolveWorkflowFailureNotificationPolicy(
      transaction,
      parsed.workflowId,
    );
  const identifiers = allocateWorkflowRunAcceptanceIdentifiers();
  if (!(await claimWorkflowRunAcceptance(transaction, parsed, identifiers))) {
    const racedAcceptance = await readExistingAcceptance(transaction, parsed, {
      kind: 'exact_initial_checkpoint',
      hash: initialCheckpointHash,
    });
    if (racedAcceptance === null) throw new IdempotencyRecordCorruptError();
    return racedAcceptance;
  }

  return persistWorkflowRunAcceptance(transaction, parsed, {
    ...identifiers,
    initialCheckpointJson,
    initialCheckpointHash,
    storedRunInputJson,
    failureNotificationPolicy,
  });
}
