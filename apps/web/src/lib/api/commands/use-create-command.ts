import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { isUnconfirmedCommand } from './command-retry';
import { useHeldCommandKey } from './use-held-command-key';

/**
 * A create the server can tell apart only by its idempotency key: nothing in
 * the new resource is unique, so no revision stops a second one. Beyond the
 * shared key rule, a held key whose receipt window ended refuses to send until
 * the person starts a new attempt, and an unconfirmed create offers its exact
 * resend.
 */
export function useCreateCommand<Input, Result>({
  send,
  refresh,
}: Readonly<{
  send: (input: Input, key: string) => Promise<Result>;
  refresh: (input: Input) => Promise<unknown>;
}>) {
  const keys = useHeldCommandKey<Input>('refuse');
  // Stays set across a throttled resend: only a settled key clears it.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const mutation = useMutation({
    retry: false,
    mutationFn: ({ input, key }: Readonly<{ input: Input; key: string }>) =>
      send(input, key),
    onSettled: async (_result, _error, { input }) => {
      // Read errors stay with their queries; the held key is unaffected.
      await Promise.allSettled([refresh(input)]);
    },
  });

  /** Resolves to `undefined` when the held attempt's retry window ended. */
  async function create(input: Input): Promise<Result | undefined> {
    const before = keys.held()?.idempotencyKey;
    const held = await keys.keyFor(input);
    if (held === undefined) return undefined;
    if (held.idempotencyKey !== before) setUnconfirmed(false);
    try {
      const result = await mutation.mutateAsync({
        input,
        key: held.idempotencyKey,
      });
      keys.settle();
      setUnconfirmed(false);
      return result;
    } catch (cause) {
      keys.settle(cause);
      if (isUnconfirmedCommand(cause)) setUnconfirmed(true);
      else if (keys.held() === undefined) setUnconfirmed(false);
      throw cause;
    }
  }

  return {
    create,
    pending: mutation.isPending,
    data: mutation.data,
    failed: mutation.isError,
    error: mutation.error,
    /** An earlier send may have been accepted; resending the same input is safe. */
    uncertain: mutation.isError && unconfirmed,
    expired: keys.expired,
    reset: mutation.reset,
    /** Resend the held input exactly, with its key. */
    retry: async (): Promise<Result | undefined> => {
      const held = keys.held();
      return held === undefined ? undefined : create(held.input);
    },
    /** Forget the held key after the person checked the outcome. */
    startNewAttempt: () => {
      keys.release();
      setUnconfirmed(false);
      mutation.reset();
    },
  };
}
