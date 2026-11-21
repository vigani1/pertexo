import {
  RESEND_API_KEY_CONNECTION,
  SMTP_CONNECTION,
} from './connections.definition.js';
import type { IntegrationModule } from '../providers/integration-module.js';
import {
  EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
  EMAIL_SEND_NOTIFICATION_POLICY,
} from './send-notification/send-notification.definition.js';

export const EMAIL_MODULE = {
  key: 'email',
  presentation: { name: 'Email', icon: 'mail', group: 'action' },
  connections: [RESEND_API_KEY_CONNECTION, SMTP_CONNECTION],
  steps: [{ registration: EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION }],
  policies: [EMAIL_SEND_NOTIFICATION_POLICY],
} satisfies IntegrationModule;
