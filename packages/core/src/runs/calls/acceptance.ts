import { EXECUTING_RUN_STATUSES } from '../../shared/run-records/run-statuses.js';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import {
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../commands/acceptance/run-admission.errors.js';
import { WorkflowCallRefusedError } from './workflow-call.errors.js';

export type CallParentState = Readonly<{
  status: string;
  cancel_requested_at: Date | null;
  deadline_expired: boolean | null;
  has_wait: boolean;
  has_ordinary_work: boolean;
}>;

/** A parent takes its child only while it waits on this call and nothing else runs. */
export function callParentWaiting(parent: CallParentState): boolean {
  return (
    EXECUTING_RUN_STATUSES.some((status) => status === parent.status) &&
    parent.cancel_requested_at === null &&
    !(parent.deadline_expired ?? false) &&
    parent.has_wait &&
    !parent.has_ordinary_work
  );
}

/** The refusal code an admission failure leaves on the call, or undefined to rethrow. */
export function callAdmissionRefusal(error: unknown): string | undefined {
  if (error instanceof WorkflowCallRefusedError) return error.code;
  if (error instanceof CallableInputInvalidError) return 'call_input_invalid';
  if (error instanceof WorkspaceRunQuotaExceededError)
    return 'call_target_capacity_exceeded';
  if (error instanceof WorkspaceRunAdmissionDeniedError)
    return 'call_target_unavailable';
  return undefined;
}
