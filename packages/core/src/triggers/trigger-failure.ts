import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { isStoredDataError } from '../shared/stored-values.js';

export type ScheduleFailureReason =
  | 'schedule.recurrence_invalid'
  | 'schedule.execution_incompatible'
  | 'schedule.scan_failed';

export function scheduleFailureReason(error: unknown): ScheduleFailureReason {
  return error instanceof WorkflowEngineError || isStoredDataError(error)
    ? 'schedule.execution_incompatible'
    : 'schedule.scan_failed';
}

export function reconciliationFailureReason(error: unknown) {
  return isStoredDataError(error)
    ? 'trigger.configuration_invalid'
    : 'trigger.reconciliation_failed';
}
