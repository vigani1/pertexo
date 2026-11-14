import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { RETRY_WINDOW_ENDED, isUnconfirmedCommand } from './command-retry';
import { describeCommandError } from '../error-copy';
import { useHeldCommandKey } from './use-held-command-key';

/**
 * For changes that set an absolute state and carry no revision: the read
 * that shows the current state, and whether its data shows this change.
 */
export type AppliedIn<Input, Data> = Readonly<{
  read: QueryKey;
  shows: (data: Data, input: Input) => boolean;
}>;

/**
 * Changes a revision or absolute state guards: every outcome refreshes the
 * current reads, and the key follows `useHeldCommandKey`, so resending an
 * unchanged change after a lost response replays it rather than being
 * refused as someone else's.
 */
export function useLowEffectMutation<Input, Result, Data = unknown>({
  send,
  refresh,
  appliedIn,
  slotOf,
}: Readonly<{
  send: (input: Input, key: string) => Promise<Result>;
  /** `error` is null when the change landed. */
  refresh: (input: Input, error: unknown) => Promise<unknown>;
  /**
   * When a read that succeeded after an unconfirmed outcome doesn't show
   * the change, the held key goes, so saving again applies it (harmless,
   * it sets a state) rather than replaying an old receipt that someone
   * else's change has since undone. Without such a read the key stays.
   */
  appliedIn?: AppliedIn<Input, Data>;
  /**
   * The target a change is made to, when one hook changes several (a
   * folder, a tag): each target keeps its own held key.
   */
  slotOf?: (input: Input) => string;
}>) {
  const cache = useQueryClient();
  const keys = useHeldCommandKey<Input>('renew', slotOf);
  return useMutation({
    retry: false,
    mutationFn: async (input: Input) => {
      // Decided at each send, not once: a read that answered after the
      // lost outcome (the refresh, or a later refetch on focus) and doesn't
      // show the change means the old receipt no longer stands for it.
      const unconfirmedAt = keys.heldFor(input)?.unconfirmedAt;
      if (
        appliedIn !== undefined &&
        unconfirmedAt !== undefined &&
        readDisagrees(cache, appliedIn, unconfirmedAt, input)
      )
        keys.forget(input);
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
      await Promise.allSettled([refresh(input, error)]);
    },
  });
}

/**
 * A read that answered at or after `since` and doesn't show the change. A
 * refetch that failed (invalidateQueries resolves anyway) or never ran
 * leaves older data, which proves nothing.
 */
function readDisagrees<Input, Data>(
  cache: QueryClient,
  appliedIn: AppliedIn<Input, Data>,
  since: number,
  input: Input,
): boolean {
  const read = cache.getQueryState<Data>(appliedIn.read);
  return (
    read?.status === 'success' &&
    read.data !== undefined &&
    read.dataUpdatedAt >= since &&
    !appliedIn.shows(read.data, input)
  );
}

export function lowEffectError(error: unknown, action: string): string {
  return isUnconfirmedCommand(error)
    ? 'We couldn’t confirm that change. Saving it again is safe — it won’t apply twice.'
    : describeCommandError(error, action);
}
