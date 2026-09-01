import type { Meter, Tracer } from '@opentelemetry/api';
import type { EmailSendNotificationOutput } from '@pertexo/integrations';
import {
  EmailSendNotificationExecutorError,
  type EmailSendNotificationExecutorTelemetry,
} from '@pertexo/integrations/server';

import { createProductionProviderTelemetry } from './provider-telemetry.js';

export function createProductionEmailProviderTelemetry(
  options: Readonly<{ meter?: Meter; tracer?: Tracer }> = {},
): EmailSendNotificationExecutorTelemetry {
  return createProductionProviderTelemetry<EmailSendNotificationOutput>({
    instrumentationName: '@pertexo/worker.provider-email',
    spanName: 'pertexo.provider.email.send_notification',
    providerKey: 'email',
    operationKey: 'send_notification',
    classifyFailure: (error) =>
      error instanceof EmailSendNotificationExecutorError
        ? {
            outcome: error.kind,
            errorClass: error.errorKind,
            possiblyDispatched: error.possiblyDispatched,
          }
        : undefined,
    ...options,
  });
}
