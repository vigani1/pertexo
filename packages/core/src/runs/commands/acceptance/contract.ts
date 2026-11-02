import type { RunInputValidator } from '../initial-checkpoint.js';
import type { RunStatus as EngineRunStatus } from '@pertexo/workflow-engine';
import type { resolveWorkflowFailureNotificationPolicy } from '../../../notifications/policies/admission.queries.js';
import type { WorkflowRecoverySummary } from '../../recovery/contract.js';

export type AcceptWorkflowRunInput = Readonly<{
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
}>;

export type AcceptedWorkflowRun = Readonly<{
  acceptedAt: Date;
  duplicate: boolean;
  outboxEventId: string;
  runId: string;
  status: EngineRunStatus;
}>;

export type PreparedWorkflowRunAcceptance = Readonly<{
  runId?: string;
  variableSetRevision?: number | null;
  errorWorkflowOrigin?: boolean;
  recovery?: WorkflowRecoverySummary;
  failureNotificationPolicy: Awaited<
    ReturnType<typeof resolveWorkflowFailureNotificationPolicy>
  >;
}>;

export type WorkflowRunAcceptanceReplayInput = Pick<
  AcceptWorkflowRunInput,
  'keyHash' | 'requestHash' | 'operation' | 'scope'
>;
