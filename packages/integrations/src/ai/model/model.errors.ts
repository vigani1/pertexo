import {
  NodeExecutorFailure,
  type NodeExecutorErrorKind,
} from '@pertexo/node-sdk/server';

const modelErrors = {
  address_denied: 'configuration',
  credential_rejected: 'authentication',
  model_unavailable: 'provider',
  output_truncated: 'provider',
  output_refused: 'provider',
  provider_timeout: 'timeout',
  rate_limited: 'rate_limit',
  output_schema_invalid: 'provider',
  invalid_response: 'provider',
  request_too_large: 'configuration',
  response_too_large: 'provider',
  credential_echoed: 'provider',
  retry_after_exceeded: 'rate_limit',
} as const satisfies Record<string, NodeExecutorErrorKind>;

type ModelError = keyof typeof modelErrors;
export const MODEL_FAILURE_CODES = Object.keys(modelErrors).map(
  (code) => `model.${code}`,
);

export function modelFailure(
  code: ModelError,
  options: Readonly<{
    kind?: 'failed' | 'retry';
    possiblyDispatched: boolean;
    minimumRetryDelayMillis?: number | undefined;
  }>,
): NodeExecutorFailure {
  return new NodeExecutorFailure({
    kind: 'failed',
    ...options,
    errorKind: modelErrors[code],
    safeErrorCode: `model.${code}`,
  });
}
