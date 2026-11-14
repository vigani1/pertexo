import { useState } from 'react';
import { isApiError } from '../error';
import {
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from './command-retry';
import { useCommandAttempt } from './use-command-attempt';

type HeldKey<Input> = Readonly<{
  intent: string;
  slot: string;
  input: Input;
  /** When a send under this key ended without a confirmed outcome. */
  unconfirmedAt?: number;
}> &
  CommandKey;

// Held keys of other targets, set aside while this hook sends to another.
const SET_ASIDE_LIMIT = 16;

/**
 * The one key rule for keyed commands. A send reuses the held key while its
 * input is unchanged, so a resend after a lost response replays the server's
 * receipt instead of applying the change again or being refused as stale. A
 * changed input gets a new key. Success, or a refusal that settled the key,
 * releases it.
 *
 * Each target (`slotOf`, one for the whole hook by default) holds its own
 * key: a command to another target sets the held key aside, so resending
 * the first command later still replays its own receipt. Another command to
 * the same target replaces it, since the target's state has moved on.
 *
 * When the held key's receipt window ends, `renew` takes a new key (for
 * changes a revision or absolute state still guards) and `refuse` sends
 * nothing until the person starts a new attempt (for creates nothing else
 * guards).
 */
export function useHeldCommandKey<Input>(
  whenExpired: 'renew' | 'refuse',
  slotOf: (input: Input) => string = () => '',
) {
  const attempt = useCommandAttempt<HeldKey<Input>>();
  const [setAside] = useState(() => new Map<string, HeldKey<Input>>());
  function setCurrentAside(held: HeldKey<Input>) {
    setAside.delete(held.slot);
    setAside.set(held.slot, held);
    const [oldest] = setAside.keys();
    if (setAside.size > SET_ASIDE_LIMIT && oldest !== undefined)
      setAside.delete(oldest);
  }
  return {
    /** Resolves to `undefined` only when a refused attempt's window ended. */
    keyFor: async (input: Input) => {
      const intent = intentOf(input);
      const slot = slotOf(input);
      const current = attempt.current();
      if (current !== undefined && current.intent !== intent) {
        if (current.slot !== slot) setCurrentAside(current);
        attempt.clear();
      }
      const waiting = setAside.get(slot);
      if (waiting !== undefined) {
        setAside.delete(slot);
        if (waiting.intent === intent) attempt.adopt(waiting);
      }
      const held = attempt.current();
      if (held !== undefined && whenExpired === 'renew' && !canResend(held))
        attempt.clear();
      return attempt.getOrCreate(() => ({
        intent,
        slot,
        input,
        ...newCommandKey(),
      }));
    },
    /** Record a send's outcome: no cause means it succeeded. */
    settle: (cause?: unknown) => {
      if (cause === undefined || settlesKey(cause)) {
        attempt.clear();
        return;
      }
      const held = attempt.current();
      if (held !== undefined && isUnconfirmedCommand(cause))
        attempt.adopt({ ...held, unconfirmedAt: Date.now() });
    },
    held: () => attempt.current(),
    /** The key held for this input, current or set aside. */
    heldFor: (input: Input): HeldKey<Input> | undefined => {
      const intent = intentOf(input);
      const current = attempt.current();
      if (current?.intent === intent) return current;
      const waiting = setAside.get(slotOf(input));
      return waiting?.intent === intent ? waiting : undefined;
    },
    /** Drops the key held for this input, wherever it waits. */
    forget: (input: Input) => {
      const intent = intentOf(input);
      const slot = slotOf(input);
      if (setAside.get(slot)?.intent === intent) setAside.delete(slot);
      if (attempt.current()?.intent === intent) attempt.clear();
    },
    expired: attempt.expired,
    release: () => {
      setAside.clear();
      attempt.clear();
    },
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
