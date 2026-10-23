import {
  NodeExecutionAbortedError,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';

import { operationError } from '../operation-values.js';

export function assertIdentity(
  value: string,
  label: string,
  code: 'attempt_invalid' | 'workflow_identity_invalid',
): void {
  if (value.length === 0 || value.length > 256)
    operationError(code, `${label} is invalid`);
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    operationError('attempt_aborted', 'node attempt was aborted');
}

export function isAbortError(error: unknown): boolean {
  try {
    if (error instanceof NodeExecutionAbortedError) return true;
    if (!(error instanceof Error)) return false;
    return error.name === 'AbortError';
  } catch {
    return false;
  }
}

export function isNodeExecutorFailure(
  error: unknown,
): error is NodeExecutorFailure {
  try {
    return error instanceof NodeExecutorFailure;
  } catch {
    return false;
  }
}
