import { isApiError } from '@/lib/api/error';
import { isUncertainOutcome } from '@/lib/api/error-copy';
export const RUN_COMMAND_WINDOW_MS = 86_400_000;
/** A server error can be returned after admission committed, so keep its key. */
export function isUnconfirmedRunCommand(cause: unknown): boolean {
  return (
    isUncertainOutcome(cause) ||
    (isApiError(cause) && (cause.status ?? 0) >= 500)
  );
}

export const RUN_COMMAND_EXPIRED_MESSAGE =
  'The original request’s 24-hour retry window has ended. Check run history before starting another run.';
