import { useMutation } from '@tanstack/react-query';
import { RETRY_WINDOW_ENDED, isUnconfirmedCommand } from './command-retry';
import { describeCommandError } from '../error-copy';
import { useHeldCommandKey } from './use-held-command-key';

/**
 * Changes a revision or absolute state guards: every outcome refreshes the
 * current reads, and the key follows `useHeldCommandKey`, so resending an
 * unchanged change after a lost response replays it rather than being
 * refused as someone else's.
 */
export function useLowEffectMutation<Input, Result>({
  send,
  refresh,
}: Readonly<{
  send: (input: Input, key: string) => Promise<Result>;
  refresh: (input: Input) => Promise<unknown>;
}>) {
  const keys = useHeldCommandKey<Input>('renew');
  return useMutation({
    retry: false,
    mutationFn: async (input: Input) => {
      const held = await keys.keyFor(input);
      // Renewing keys are never refused; this guards the contract.
      if (held === undefined) throw new Error(RETRY_WINDOW_ENDED);
      try {
        const result = await send(input, held.idempotencyKey);
        keys.settle();
        return result;
      } catch (cause) {
        keys.settle(cause);
        throw cause;
      }
    },
    onSettled: async (_result, _error, input) => {
      // Read errors stay with their queries. A failed refresh cannot turn an
      // accepted write into an unconfirmed command or invite a second write.
      await Promise.allSettled([refresh(input)]);
    },
  });
}

export function lowEffectError(error: unknown, action: string): string {
  return isUnconfirmedCommand(error)
    ? 'We couldn’t confirm that change. Check the refreshed current state before trying again.'
    : describeCommandError(error, action);
}
