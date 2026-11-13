import { useRef, useState } from 'react';
import { canResend, type CommandKey } from './command-retry';
import { useResendExpired } from './use-resend-window';

/** A held attempt may be replayed or explicitly retired; expiry never creates one. */
export function useCommandAttempt<Attempt extends CommandKey>() {
  const current = useRef<Attempt | undefined>(undefined);
  const [held, setHeld] = useState<Attempt>();
  const [refused, setRefused] = useState(false);
  const expired = useResendExpired(held);
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
    getOrCreate: async (
      create: () => Attempt | Promise<Attempt>,
    ): Promise<Attempt | undefined> => {
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
    },
  };
}
