import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import {
  parseInitialWorkflowCheckpointV3,
  serializePersistedWorkflowCheckpointV3,
} from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import type { WorkspaceTransaction } from '../../tenant-access/workspace.js';
import {
  lockWorkflowCallAdmission,
  workflowCallAdmissionContextSchema,
} from '../workflow-calls/workflow-call-admission.js';
import {
  acceptWorkflowRunInputSchema,
  IdempotencyRecordCorruptError,
  type AcceptedWorkflowRun,
} from './execution-acceptance-contract.js';
import {
  allocateWorkflowRunAcceptanceIdentifiers,
  claimWorkflowRunAcceptance,
} from './execution-acceptance-claim.js';
import { persistWorkflowRunAcceptance } from './execution-acceptance-persistence.js';
import { resolveWorkflowFailureNotificationPolicy } from '../notifications/failure-notification-policy.js';

/** Internal extension only: actual Call input is derived by the SQL proof. */
export const acceptWorkflowCallRunInputSchema = acceptWorkflowRunInputSchema
  .omit({
    runInput: true,
    deadlineAt: true,
    replayCommandId: true,
    replaySourceRunId: true,
    scope: true,
    keyHash: true,
    requestHash: true,
  })
  .extend({
    triggerType: z.literal('workflow_call'),
    call: workflowCallAdmissionContextSchema,
  })
  .strict();
export type AcceptWorkflowCallRunInput = Readonly<
  z.input<typeof acceptWorkflowCallRunInputSchema>
>;
type ParsedCallInput = z.output<typeof acceptWorkflowCallRunInputSchema>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Private branch of canonical acceptance, not a second acceptance protocol.
 * The coordinator owns the outer transaction and candidate savepoint, ordered
 * prerequisite locks, durable journal, parent CAS and refusal/control handling.
 * Unexpected errors (including every SQLSTATE) escape for whole-transaction
 * recovery. No generic receipt can replace an expired durable Call identity.
 */
export async function acceptCanonicalWorkflowCallRun(
  transaction: WorkspaceTransaction,
  parsed: ParsedCallInput,
): Promise<AcceptedWorkflowRun> {
  const initialCheckpointJson = serializePersistedWorkflowCheckpointV3(
    parseInitialWorkflowCheckpointV3(parsed.initialCheckpoint, parsed),
  );
  const initialCheckpointHash = sha256(initialCheckpointJson);
  const identifiers = allocateWorkflowRunAcceptanceIdentifiers();
  const proof = await lockWorkflowCallAdmission(transaction, {
    context: parsed.call,
    candidateRunId: identifiers.runId,
    workflowId: parsed.workflowId,
    workflowVersionId: parsed.workflowVersionId,
    engineVersion: parsed.engineVersion,
  });
  if (proof.kind === 'recorded') return proof.accepted;
  // SQL has prelocked notification prerequisites before its parent/lineage CAS.
  // Reusing those held locks cannot introduce a late lower-order acquisition.
  const failureNotificationPolicy =
    await resolveWorkflowFailureNotificationPolicy(
      transaction,
      parsed.workflowId,
    );
  const acceptance = {
    engineVersion: parsed.engineVersion,
    initialCheckpoint: parsed.initialCheckpoint,
    workflowId: parsed.workflowId,
    workflowVersionId: parsed.workflowVersionId,
    triggerType: 'workflow_call' as const,
    operation: 'workflow.run.accept' as const,
    scope: `workflow-call:${parsed.call.parentRunId}`,
    keyHash: sha256(parsed.call.invocationKey),
    requestHash: sha256(
      canonicalJson({
        pin: proof.pin,
        inputChecksum: proof.inputChecksum,
        initialCheckpointHash,
      }),
    ),
    ...(parsed.traceparent === undefined
      ? {}
      : { traceparent: parsed.traceparent }),
  };
  if (!(await claimWorkflowRunAcceptance(transaction, acceptance, identifiers)))
    throw new IdempotencyRecordCorruptError();
  return persistWorkflowRunAcceptance(transaction, acceptance, {
    ...identifiers,
    initialCheckpointJson,
    initialCheckpointHash,
    storedRunInputJson: proof.storedInputJson,
    failureNotificationPolicy,
    callAdmission: proof,
  });
}
