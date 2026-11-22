import type { workflowRuns } from '@pertexo/database/schema';
import type { WorkflowRunSource } from '@pertexo/workflow-model';
import type { RunInputValidator } from '../initial-checkpoint.types.js';
import type { RunStatus as EngineRunStatus } from '@pertexo/workflow-engine';
import type { resolveWorkflowFailureNotificationPolicy } from '../../../notifications/policies/admission.repository.js';
import type { WorkflowRecoverySummary } from '../../recovery/workflow-recovery.types.js';

export type AcceptWorkflowRunInput = Readonly<{
  initialCheckpoint: unknown;
  mcpInvocation?: (
    runId: string,
  ) => NonNullable<(typeof workflowRuns.$inferInsert)['mcpInvocation']>;
  keyHash: string;
  operation: 'workflow.run.accept';
  requestHash: string;
  scope: string;
  triggerType: WorkflowRunSource;
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
