import { lockWorkspaceExecutionCounter } from '../../admission-locks.repository.js';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { requireRunTableReferences } from '../../../data-tables/columns/references.repository.js';
import { requireWorkflowConcurrency } from './concurrency.repository.js';
import { variableRevisionForAcceptance } from './variables.repository.js';
import { requireFormAdmission } from './forms.repository.js';
import { lockExecutionArtifactReferences } from '../../../artifacts/references/locks.repository.js';
import { generatePersistedId } from '@pertexo/database/platform';
import { prepareStoredExecutionValue } from '../../../shared/stored-execution.js';
import { enqueueAdvance } from '../../../outbox/run-advance.repository.js';
import { resolveWorkflowFailureNotificationPolicy } from '../../../notifications/policies/admission.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { prepareWorkflowRunAcceptanceInput } from './checkpoint.js';
import { RUN_STATUS } from '@pertexo/workflow-model';
import type {
  AcceptWorkflowRunInput,
  AcceptedWorkflowRun,
  PreparedWorkflowRunAcceptance,
} from './run-acceptance.types.js';
import { IdempotencyRecordCorruptError } from '../../../shared/command-receipt.errors.js';
import { readExistingAcceptance } from './replay.repository.js';
import {
  throwWorkflowRunAdmissionError,
  assertWorkspaceAcceptsNewRuns,
} from './admission.repository.js';
import {
  claimAcceptance,
  completeAcceptance,
  insertAcceptedRun,
  insertRunStart,
  readErrorWorkflowOrigin,
  type RunAdmissionState,
} from './accepted-run.repository.js';
/** Call spawn acquires ordinary admission prerequisites before its parent lock. */
export async function prepareWorkflowRunAcceptance(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<PreparedWorkflowRunAcceptance> {
  try {
    await assertWorkspaceAcceptsNewRuns(transaction);
  } catch (error: unknown) {
    throwWorkflowRunAdmissionError(error);
  }
  return {
    failureNotificationPolicy: await resolveWorkflowFailureNotificationPolicy(
      transaction,
      workflowId,
    ),
  };
}

export async function acceptWorkflowRun(
  transaction: WorkspaceTransaction,
  input: AcceptWorkflowRunInput,
  preparation?: PreparedWorkflowRunAcceptance,
): Promise<AcceptedWorkflowRun> {
  const preparedRunInput =
    input.runInput === undefined
      ? null
      : prepareStoredExecutionValue({
          kind: 'inline',
          value: input.runInput,
        });
  const storedRunInputJson = preparedRunInput?.json ?? null;
  const { initialCheckpointJson, initialCheckpointHash } =
    prepareWorkflowRunAcceptanceInput(input);
  const existing = await readExistingAcceptance(transaction, input, {
    kind: 'exact_initial_checkpoint',
    hash: initialCheckpointHash,
  });
  if (existing !== null) return existing;
  await requireFormAdmission(transaction, input, preparedRunInput?.value);
  input.validateInput?.(
    preparedRunInput?.value.kind === 'inline'
      ? preparedRunInput.value.value
      : undefined,
    storedRunInputJson === null ? 0 : utf8ByteLength(storedRunInputJson),
  );

  const prepared =
    preparation ??
    (await prepareWorkflowRunAcceptance(transaction, input.workflowId));
  const sourceOrigin =
    input.replaySourceRunId === undefined
      ? false
      : await readErrorWorkflowOrigin(transaction, input.replaySourceRunId);
  const variableSetRevision = await variableRevisionForAcceptance(
    transaction,
    input.replaySourceRunId,
    prepared.variableSetRevision,
  );
  const idempotencyRecordId = generatePersistedId();
  const runId = prepared.runId ?? generatePersistedId();
  const outboxEventId = generatePersistedId();
  const resultRef = {
    outboxEventId,
    initialCheckpointHash,
  } as const;

  const claimed = await claimAcceptance(transaction, input, {
    id: idempotencyRecordId,
    runId,
  });
  if (!claimed) {
    const racedAcceptance = await readExistingAcceptance(transaction, input, {
      kind: 'exact_initial_checkpoint',
      hash: initialCheckpointHash,
    });
    if (racedAcceptance === null) throw new IdempotencyRecordCorruptError();
    return racedAcceptance;
  }

  const insertedRun = await insertAcceptedWorkflowRun(transaction, input, {
    prepared,
    runId,
    storedRunInputJson,
    variableSetRevision,
    sourceOrigin,
  });
  await insertRunStart(transaction, input, { runId, initialCheckpointJson });
  await enqueueAdvance(transaction.db, {
    workspaceId: transaction.workspaceId,
    runId,
    outboxEventId,
    traceparent: input.traceparent,
  });
  if (!(await completeAcceptance(transaction, idempotencyRecordId, resultRef)))
    throw new IdempotencyRecordCorruptError();

  return Object.freeze({
    acceptedAt: insertedRun.acceptedAt,
    duplicate: false,
    outboxEventId,
    runId,
    status: RUN_STATUS.queued,
  });
}

async function insertAcceptedWorkflowRun(
  transaction: WorkspaceTransaction,
  parsed: AcceptWorkflowRunInput,
  state: RunAdmissionState,
) {
  let insertedRun;
  await lockExecutionArtifactReferences(transaction, parsed.runInput);
  try {
    await requireWorkflowConcurrency(
      transaction,
      parsed.workflowId,
      parsed.triggerType,
    );
    if (parsed.triggerType !== 'test')
      await requireRunTableReferences(transaction, parsed.workflowVersionId);
    // Calls/tests skip workflow concurrency, but still serialize workspace
    // capacity before the final standing check and the SQL capacity write.
    await lockWorkspaceExecutionCounter(
      transaction.db,
      transaction.workspaceId,
    );
    await assertWorkspaceAcceptsNewRuns(transaction);
    insertedRun = await insertAcceptedRun(transaction, parsed, state);
  } catch (error: unknown) {
    throwWorkflowRunAdmissionError(error);
  }
  if (insertedRun === undefined) throw new IdempotencyRecordCorruptError();
  return insertedRun;
}
