import { isApiError } from '../error';
import { isUncertainOutcome } from '../error-copy';

/** How long the server keeps a command's receipt for its idempotency key. */
export const COMMAND_RETRY_WINDOW_MS = 86_400_000;

export const RETRY_WINDOW_ENDED =
  'This request’s 24-hour retry window has ended. Check its result before starting again.';

/** An idempotent command's key and when it was first sent. */
export type CommandKey = Readonly<{
  idempotencyKey: string;
  createdAt: number;
}>;

export function newCommandKey(): CommandKey {
  return { idempotencyKey: crypto.randomUUID(), createdAt: Date.now() };
}

/**
 * Whether resending a command's key still reaches its receipt. Past the
 * window the server has forgotten the key, so a resend could run it twice.
 */
export function canResend(command: Pick<CommandKey, 'createdAt'>): boolean {
  return Date.now() < command.createdAt + COMMAND_RETRY_WINDOW_MS;
}

/** A server error can be returned after admission committed, so keep its key. */
export function isUnconfirmedCommand(cause: unknown): boolean {
  return (
    isUncertainOutcome(cause) ||
    (isApiError(cause) && (cause.status ?? 0) >= 500)
  );
}
