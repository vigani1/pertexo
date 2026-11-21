import { EMAIL_ATTACHMENT_ERROR_CODES } from './attachments/attachment.errors.js';
import { createResendClient } from './client.js';
import {
  RESEND_API_KEY_CONNECTION,
  SMTP_CONNECTION,
} from './connections.definition.js';
import { createEmailSendNotificationExecutorRegistration } from './send-notification/send-notification.executor.js';
import type { IntegrationModule } from '../providers/integration-module.js';
import {
  EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
  EMAIL_SEND_NOTIFICATION_POLICY,
} from './send-notification/send-notification.definition.js';

export const EMAIL_MODULE = {
  key: 'email',
  presentation: { name: 'Email', icon: 'mail', group: 'action' },
  executorSummaryCodes: [...Object.values(EMAIL_ATTACHMENT_ERROR_CODES)],
  connections: [RESEND_API_KEY_CONNECTION, SMTP_CONNECTION],
  steps: [
    {
      registration: EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
      createExecutor: ({
        fixedEndpointHttpClient,
        smtp,
        emailSendNotification,
        emailSendNotificationTelemetry,
      }) =>
        createEmailSendNotificationExecutorRegistration({
          ...(emailSendNotification ?? {
            client: createResendClient(fixedEndpointHttpClient),
            ...(smtp === undefined ? {} : { smtp }),
          }),
          ...(emailSendNotificationTelemetry === undefined
            ? {}
            : { telemetry: emailSendNotificationTelemetry }),
        }),
    },
  ],
  policies: [EMAIL_SEND_NOTIFICATION_POLICY],
} satisfies IntegrationModule;
