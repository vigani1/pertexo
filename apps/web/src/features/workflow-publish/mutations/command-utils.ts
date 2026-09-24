import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import { isApiError } from '@/lib/api/api-error';

export function isUncertainCommandError(error: unknown): boolean {
  return isUncertainOutcome(error);
}

export function parseCommandJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new Error(message, { cause });
  }
}

/**
 * One sentence for a failed publish, run or test. `action` is a noun phrase
 * such as "publishing" or "this run", used as "Your role doesn’t allow …".
 */
export function commandErrorMessage(error: unknown, action: string): string {
  if (error instanceof Error && !isApiError(error)) return error.message;
  if (isUncertainOutcome(error))
    return `We couldn’t confirm whether ${action} went through. Retrying is safe: it won’t happen twice.`;
  if (isApiError(error) && (error.status === 409 || error.status === 412))
    return 'The draft changed after it was saved. Check the latest changes and try again.';
  if (isApiError(error) && error.status === 422)
    return `${capitalize(action)} was stopped by issues in the workflow. Fix them and try again.`;
  return describeCommandError(error, action);
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
