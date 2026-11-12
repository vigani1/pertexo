import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { canonicalJson } from '@pertexo/workflow-model';
import { isApiError } from '../error';
import {
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from './command-retry';
import { useCommandAttempt } from './use-command-attempt';

type CreateAttempt<Input> = Readonly<{ intent: string; input: Input }> &
  CommandKey;

/**
 * A create the server can tell apart only by its idempotency key: nothing in
 * the new resource is unique. An unchanged intent therefore keeps its key
 * until a definitive answer, so resending after a lost response replays the
 * receipt instead of creating a second resource. A changed intent is a new
 * request with a new key.
 */
export function useCreateCommand<Input, Result>({
  send,
  refresh,
}: Readonly<{
  send: (input: Input, key: string) => Promise<Result>;
  refresh: (input: Input) => Promise<unknown>;
}>) {
  const attempt = useCommandAttempt<CreateAttempt<Input>>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const mutation = useMutation({
    retry: false,
    mutationFn: ({ input, key }: Readonly<{ input: Input; key: string }>) =>
      send(input, key),
    onSettled: async (_result, _error, { input }) => {
      // Read errors stay with their queries; the attempt's key is unaffected.
      await Promise.allSettled([refresh(input)]);
    },
  });
  function release() {
    attempt.clear();
    setUnconfirmed(false);
  }

  /** Resolves to `undefined` when the held attempt's retry window ended. */
  async function create(input: Input): Promise<Result | undefined> {
    const intent = canonicalJson(input);
    if (attempt.current()?.intent !== intent) release();
    const held = await attempt.getOrCreate(() => ({
      intent,
      input,
      ...newCommandKey(),
    }));
    if (held === undefined) return undefined;
    try {
      const result = await mutation.mutateAsync({
        input,
        key: held.idempotencyKey,
      });
      release();
      return result;
    } catch (cause) {
      if (isUnconfirmedCommand(cause)) setUnconfirmed(true);
      else if (settlesKey(cause)) release();
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
    expired: attempt.expired,
    reset: mutation.reset,
    /** Resend the held input exactly, with its key. */
    retry: async (): Promise<Result | undefined> => {
      const held = attempt.current();
      return held === undefined ? undefined : create(held.input);
    },
    /** Forget the held key after the person checked the outcome. */
    startNewAttempt: () => {
      release();
      mutation.reset();
    },
  };
}

/**
 * Throttling and sign-in or access refusals happen before the server looks
 * the key up, so they say nothing about whether an earlier send was accepted.
 */
function settlesKey(cause: unknown): boolean {
  return !(isApiError(cause) && [401, 403, 429].includes(cause.status ?? 0));
}
