import {
  authenticationMailAssociatedData,
  type ApplicationSecretEnvelope,
} from '@pertexo/secrets/server';
import type { FailureNotificationMailToSeal } from '@pertexo/core/notifications';
import { render } from '../notifications/delivery/failure-notification-content.js';

export function sealFailureAlert(
  envelope: ApplicationSecretEnvelope,
  fromEmail: string,
  publicWebOrigin: string,
  input: FailureNotificationMailToSeal,
) {
  const message = render(input.context, {
    workflowName: input.workflowName,
    kind: 'email',
    runUrl: new URL(
      `/w/${input.workspaceId}/runs/${input.context.runId}`,
      publicWebOrigin,
    ).href,
  });
  return envelope.seal(
    JSON.stringify({ fromEmail, toEmail: input.toEmail, ...message }),
    authenticationMailAssociatedData(
      'workflow_failure_alert',
      input.id,
      input.expiresAt,
    ),
  );
}
