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
  appliedIn,
  slotOf,
}: Readonly<{
  send: (input: Input, key: string) => Promise<Result>;
  /** `error` is null when the change landed. */
  refresh: (input: Input, error: unknown) => Promise<unknown>;
  /**
   * For changes that set an absolute state and carry no revision: whether
   * the current read shows this change. When a refresh after an unconfirmed
   * outcome doesn't, the held key goes, so saving again applies the change
   * (harmless, it sets a state) rather than replaying an old receipt that
   * someone else's change has since undone.
   */
  appliedIn?: (input: Input) => boolean;
  /**
   * The target a change is made to, when one hook changes several (a
   * folder, a tag): each target keeps its own held key.
   */
  slotOf?: (input: Input) => string;
}>) {
  const keys = useHeldCommandKey<Input>('renew', slotOf);
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
    onSettled: async (_result, error, input) => {
      // Read errors stay with their queries. A failed refresh cannot turn an
      // accepted write into an unconfirmed command or invite a second write.
      const [refreshed] = await Promise.allSettled([refresh(input, error)]);
      if (
        appliedIn !== undefined &&
        refreshed.status === 'fulfilled' &&
        isUnconfirmedCommand(error) &&
        !appliedIn(input)
      )
        keys.forget(input);
    },
  });
}

export function lowEffectError(error: unknown, action: string): string {
  return isUnconfirmedCommand(error)
    ? 'We couldn’t confirm that change. Saving it again is safe — it won’t apply twice.'
    : describeCommandError(error, action);
}
