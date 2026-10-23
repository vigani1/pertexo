import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import type { HttpOutcomeDecision } from '../../http/outcome-policy.js';
import type { SecureHttpClient } from '../../http/secure.js';

import type { HttpRequestOutput } from '../validation.js';

export class HttpRequestExecutorError extends NodeExecutorFailure {
  public override readonly name = 'HttpRequestExecutorError';
  public override readonly cause: unknown;

  public constructor(
    public readonly decision: HttpOutcomeDecision,
    {
      possiblyDispatched,
      cause,
    }: Readonly<{ possiblyDispatched: boolean; cause?: unknown }>,
  ) {
    if (decision.kind === 'succeeded')
      throw new TypeError('Successful HTTP outcome');
    super({
      kind: decision.kind,
      errorKind: decision.errorKind,
      possiblyDispatched,
      ...(decision.kind === 'retry' &&
      decision.minimumRetryDelayMillis !== undefined
        ? { minimumRetryDelayMillis: decision.minimumRetryDelayMillis }
        : {}),
    });
    this.cause = cause;
  }
}

export type HttpRequestExecutorDependencies = Readonly<{
  httpClient: Pick<SecureHttpClient, 'executeStreaming'>;
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
