import type { Meter, Tracer } from '@opentelemetry/api';
import type { SlackSendMessageOutput } from '@pertexo/integrations';
import {
  SlackSendMessageExecutorError,
  type SlackSendMessageExecutorTelemetry,
} from '@pertexo/integrations/server';

import { createProductionProviderTelemetry } from './provider-telemetry.js';

export function createProductionSlackProviderTelemetry(
  options: Readonly<{ meter?: Meter; tracer?: Tracer }> = {},
): SlackSendMessageExecutorTelemetry {
  return createProductionProviderTelemetry<SlackSendMessageOutput>({
    instrumentationName: '@pertexo/worker.provider-slack',
    spanName: 'pertexo.provider.slack.send_message',
    providerKey: 'slack',
    operationKey: 'send_message',
    classifyFailure: (error) =>
      error instanceof SlackSendMessageExecutorError
        ? {
            outcome: error.kind,
            errorClass: error.errorKind,
            possiblyDispatched: error.possiblyDispatched,
          }
        : undefined,
    ...options,
  });
}
