import type { ProviderHttpClient } from '../../../providers/http-client.js';

import type { HttpRequestOutput } from '../request.schemas.js';
import { HttpRequestExecutorError } from '../request.errors.js';

export type HttpRequestExecutorDependencies = Readonly<{
  httpClient: Pick<ProviderHttpClient, 'executeStreaming' | 'redactText'>;
  telemetry?: HttpRequestExecutorTelemetry;
}>;

export interface HttpRequestExecutorTelemetry {
  measure(work: () => Promise<HttpRequestOutput>): Promise<HttpRequestOutput>;
}

export const NOOP_HTTP_REQUEST_EXECUTOR_TELEMETRY: HttpRequestExecutorTelemetry =
  Object.freeze({
    measure: (work: () => Promise<HttpRequestOutput>) => work(),
  });

export function failedConfiguration(): HttpRequestExecutorError {
  return new HttpRequestExecutorError(
    Object.freeze({ kind: 'failed', errorKind: 'configuration' }),
    { possiblyDispatched: false },
  );
}
