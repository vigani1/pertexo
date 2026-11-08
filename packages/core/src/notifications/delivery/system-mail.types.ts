import type { SealedSystemMailPayload } from '@pertexo/secrets/server';
import type { FailureNotificationContext } from '@pertexo/workflow-model';

export type FailureNotificationMailToSeal = Readonly<{
  id: string;
  expiresAt: Date;
  workspaceId: string;
  toEmail: string;
  workflowName: string;
  context: FailureNotificationContext;
}>;
export type FailureNotificationMailSealer = (
  input: FailureNotificationMailToSeal,
) => SealedSystemMailPayload;
