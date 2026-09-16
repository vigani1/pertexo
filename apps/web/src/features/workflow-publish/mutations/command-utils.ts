import { isApiError } from '@/lib/api/api-error';

export function isUncertainCommandError(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'protocol')
  );
}

export function parseCommandJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new Error(message, { cause });
  }
}

export function commandErrorMessage(error: unknown, action: string): string {
  if (error instanceof Error && !isApiError(error)) return error.message;
  if (!isApiError(error)) return `Could not ${action}.`;
  if (
    error.kind === 'network' ||
    error.kind === 'timeout' ||
    error.kind === 'protocol'
  )
    return `The result is uncertain. Retry to ${action} with the same command key.`;
  if (error.status === 403) return `You do not have permission to ${action}.`;
  if (error.status === 409 || error.status === 412)
    return 'The saved workflow changed. Save and validate it again.';
  if (error.status === 422)
    return `The server could not ${action}. Review the reported validation issues.`;
  return `Could not ${action}.`;
}
