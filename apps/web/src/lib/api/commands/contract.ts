import { isApiError } from '../error';
import { isUncertainOutcome } from '../error-copy';
export const COMMAND_RETRY_WINDOW_MS = 86_400_000;
/** A server error can be returned after admission committed, so keep its key. */
export function isUnconfirmedCommand(cause: unknown): boolean {
  return (
    isUncertainOutcome(cause) ||
    (isApiError(cause) && (cause.status ?? 0) >= 500)
  );
}
