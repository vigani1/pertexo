import type { RunInputValidator } from '../initial-checkpoint.js';

export interface AcceptanceInput {
  initialCheckpoint: unknown;
  keyHash: string;
  operation: 'workflow.run.accept';
  requestHash: string;
  scope: string;
  triggerType:
    | 'test'
    | 'api'
    | 'manual'
    | 'replay'
    | 'schedule'
    | 'webhook'
    | 'workflow_call'
    | 'workflow_error'
    | 'form';
  workflowId: string;
  workflowVersionId: string;
  validateInput?: RunInputValidator | undefined;
  deadlineAt?: Date | undefined;
  absoluteDeadlineAt?: Date | null | undefined;
  startedBy?: string | undefined;
  replayCommandId?: string | undefined;
  replaySourceRunId?: string | undefined;
  runInput?: unknown;
  traceparent?: string | undefined;
}

export type AcceptanceReplayInput = Pick<
  AcceptanceInput,
  'keyHash' | 'requestHash' | 'operation' | 'scope'
>;
