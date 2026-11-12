import { isApiError } from '../error';
import {
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from './command-retry';
import { useCommandAttempt } from './use-command-attempt';

type HeldKey<Input> = Readonly<{ intent: string; input: Input }> & CommandKey;

/**
 * The one key rule for keyed commands. A send reuses the held key while its
 * input is unchanged, so a resend after a lost response replays the server's
 * receipt instead of applying the change again or being refused as stale. A
 * changed input gets a new key. Success, or a refusal that settled the key,
 * releases it.
 *
 * When the held key's receipt window ends, `renew` takes a new key (for
 * changes a revision or absolute state still guards) and `refuse` sends
 * nothing until the person starts a new attempt (for creates nothing else
 * guards).
 */
export function useHeldCommandKey<Input>(whenExpired: 'renew' | 'refuse') {
  const attempt = useCommandAttempt<HeldKey<Input>>();
  return {
    /** Resolves to `undefined` only when a refused attempt's window ended. */
    keyFor: async (input: Input) => {
      const intent = intentOf(input);
      const held = attempt.current();
      if (
        held !== undefined &&
        (held.intent !== intent ||
          (whenExpired === 'renew' && !canResend(held)))
      )
        attempt.clear();
      return attempt.getOrCreate(() => ({
        intent,
        input,
        ...newCommandKey(),
      }));
    },
    /** Record a send's outcome: no cause means it succeeded. */
    settle: (cause?: unknown) => {
      if (cause === undefined || settlesKey(cause)) attempt.clear();
    },
    held: () => attempt.current(),
    expired: attempt.expired,
    release: attempt.clear,
  };
}

/**
 * Unconfirmed outcomes say nothing about whether the send was accepted, and
 * throttling and sign-in or access refusals come before the server looks the
 * key up. Every other answer settled it.
 */
function settlesKey(cause: unknown): boolean {
  if (isUnconfirmedCommand(cause)) return false;
  return !(isApiError(cause) && [401, 403, 429].includes(cause.status ?? 0));
}

/**
 * Inputs are plain command objects; optional fields may be present but
 * undefined, which JSON drops, so key order is the only thing to normalize.
 */
function intentOf(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : Number(left > right),
          ),
        )
      : value,
  );
}
