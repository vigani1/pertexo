import type { acceptWorkflowRunInputSchema } from './input.js';
import type { RunStatus as EngineRunStatus } from '@pertexo/workflow-engine';
import type { z } from 'zod';

import type { resolveWorkflowFailureNotificationPolicy } from '../../../notifications/policies/admission.queries.js';

import type { WorkflowRecoverySummary } from '../../recovery/contract.js';

export type AcceptWorkflowRunInput = Readonly<
  z.input<typeof acceptWorkflowRunInputSchema>
>;

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

export type WorkflowRunAcceptanceReplayInput = Readonly<
  z.input<typeof acceptanceReplayInputSchema>
>;

import type { acceptanceReplayInputSchema } from './input.js';
