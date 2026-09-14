export type ProcessErrorType = 'Error' | 'NonError';

export function classifyProcessError(value: unknown): ProcessErrorType {
  try {
    return value instanceof Error ? 'Error' : 'NonError';
  } catch {
    return 'NonError';
  }
}
