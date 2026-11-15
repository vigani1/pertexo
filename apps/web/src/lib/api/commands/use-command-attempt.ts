import { useRef, useState } from 'react';
import { canResend, newCommandKey, type CommandKey } from './command-retry';
import { useResendExpired } from './use-resend-window';

/** A held attempt may be replayed or explicitly retired; expiry never creates one. */
export function useCommandAttempt<Attempt extends CommandKey>() {
  const current = useRef<Attempt | undefined>(undefined);
  const [held, setHeld] = useState<Attempt>();
  const [refused, setRefused] = useState(false);
  const expired = useResendExpired(held);
  async function getOrCreate(
    create: () => Attempt | Promise<Attempt>,
  ): Promise<Attempt | undefined> {
    const retained = current.current;
    if (retained !== undefined) {
      if (!canResend(retained)) {
        setRefused(true);
        setHeld({ ...retained });
        return undefined;
      }
      return retained;
    }
    const attempt = await create();
    current.current = attempt;
    setHeld(attempt);
    return attempt;
  }
  return {
    expired: refused || expired,
    current: () => current.current,
    clear: () => {
      setRefused(false);
      current.current = undefined;
      setHeld(undefined);
    },
    /** Makes a held attempt current again, as it was when set aside. */
    adopt: (attempt: Attempt) => {
      setRefused(false);
      current.current = attempt;
      setHeld(attempt);
    },
    getOrCreate,
    /**
     * The held attempt, or a new one with a fresh idempotency key: the one
     * place a command's key is minted for a form.
     */
    getOrCreateKeyed: (
      create: () => Omit<Attempt, keyof CommandKey>,
    ): Promise<Attempt | undefined> =>
      getOrCreate(() => ({ ...create(), ...newCommandKey() }) as Attempt),
  };
}
