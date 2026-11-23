import { MODEL_FAILURE_KINDS } from '@pertexo/workflow-model';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

type ModelError = keyof typeof MODEL_FAILURE_KINDS;
export const MODEL_FAILURE_CODES = Object.keys(MODEL_FAILURE_KINDS).map(
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
    errorKind: MODEL_FAILURE_KINDS[code],
    safeErrorCode: `model.${code}`,
  });
}
