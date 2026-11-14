import { WorkflowEngineError } from '../workflow-engine.errors.js';
export function fail(message: string): never {
  throw new WorkflowEngineError('executable_invalid', message);
}

/**
 * Runs a read of caller-supplied input. Whatever that read throws, even a
 * hostile non-Error value, becomes executable_invalid. Failures outside such
 * reads are engine defects and keep their own error.
 */
export function readUntrusted<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    normalizeError(error);
  }
}

function normalizeError(error: unknown): never {
  let isEngineError = false;
  try {
    isEngineError = error instanceof WorkflowEngineError;
  } catch {
    // Hostile rejection values are normalized below.
  }
  if (isEngineError) throw error;
  let message: string | undefined;
  try {
    if (error instanceof Error && typeof error.message === 'string')
      message = error.message;
  } catch {
    // Hostile rejection values are normalized below.
  }
  fail(message ?? 'executable processing failed');
}
