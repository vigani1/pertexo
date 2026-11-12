import { useMutation } from '@tanstack/react-query';
import { isUnconfirmedCommand } from './command-retry';
import { describeCommandError } from '../error-copy';

/** Low-effect changes reconcile current reads after every outcome; they never retain a resend. */
export function useLowEffectMutation<Input, Result>({
  send,
  refresh,
}: Readonly<{
  send: (input: Input, key: string) => Promise<Result>;
  refresh: (input: Input) => Promise<unknown>;
}>) {
  return useMutation({
    retry: false,
    mutationFn: (input: Input) => send(input, crypto.randomUUID()),
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
