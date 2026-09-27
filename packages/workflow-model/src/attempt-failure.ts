import './server-only.js';

/** Persisted executor failure codes are a protocol shared by writer and replay. */
export const SAFE_EXECUTOR_ERROR_CODE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isSafeExecutorErrorCode(value: unknown): value is string {
  return (
    typeof value === 'string' && SAFE_EXECUTOR_ERROR_CODE_PATTERN.test(value)
  );
}
