import { sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '../../tenant-access/workspace.js';
import { acceptWorkflowRun } from '../runs/execution-acceptance.js';
import type { AcceptedWorkflowRun } from '../runs/execution-acceptance-contract.js';
import {
  acceptWorkflowCallRunInputSchema,
  type AcceptWorkflowCallRunInput,
} from '../runs/workflow-call-acceptance.js';
import {
  WorkflowCallAdmissionRefusedError,
  WorkflowCallAdmissionStoppedError,
  type WorkflowCallAdmissionRefusalCode,
} from './workflow-call-admission.js';

export type WorkflowCallCandidateOutcome =
  | Readonly<{ kind: 'accepted'; accepted: AcceptedWorkflowRun }>
  | Readonly<{
      kind: 'refused';
      reasonCode: WorkflowCallAdmissionRefusalCode;
    }>
  | Readonly<{
      kind: 'stopped';
      reason: 'cancel_requested' | 'deadline_expired';
    }>;

/**
 * Internal, sequential coordinator operation on its existing transaction/client.
 * The coordinator MUST acquire all prerequisite and lineage/parent locks before
 * entering this savepoint. Recovery therefore removes candidate writes without
 * releasing the ancestor cancellation fence or parent CAS authority.
 *
 * This function neither seals a journal fact nor commits the parent checkpoint.
 * After a definite outcome the outer owner must do both atomically. Every other
 * failure escapes for WHOLE-transaction rollback/reload of the same Call identity;
 * in particular an SQLSTATE or failed savepoint cleanup is never a refusal.
 */
export async function acceptWorkflowCallCandidate(
  transaction: WorkspaceTransaction,
  input: AcceptWorkflowCallRunInput,
): Promise<WorkflowCallCandidateOutcome> {
  const parsed = acceptWorkflowCallRunInputSchema.parse(input);
  await transaction.db.execute(sql`savepoint workflow_call_candidate`);
  let accepted: AcceptedWorkflowRun;
  try {
    accepted = await acceptWorkflowRun(transaction, parsed);
  } catch (error: unknown) {
    if (
      !(error instanceof WorkflowCallAdmissionRefusedError) &&
      !(error instanceof WorkflowCallAdmissionStoppedError)
    )
      throw error;
    try {
      await transaction.db.execute(
        sql`rollback to savepoint workflow_call_candidate`,
      );
      await transaction.db.execute(
        sql`release savepoint workflow_call_candidate`,
      );
    } catch (recoveryError: unknown) {
      throw new AggregateError(
        [error, recoveryError],
        'Workflow Call candidate recovery failed; outer rollback required',
      );
    }
    return error instanceof WorkflowCallAdmissionRefusedError
      ? Object.freeze({ kind: 'refused', reasonCode: error.reasonCode })
      : Object.freeze({ kind: 'stopped', reason: error.reason });
  }
  // Release failures are outside classification: no success/fact can be returned.
  await transaction.db.execute(sql`release savepoint workflow_call_candidate`);
  return Object.freeze({ kind: 'accepted', accepted });
}
