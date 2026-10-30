import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { canonicalJson } from '@pertexo/workflow-model';
import { describeCommandError } from '../error-copy';
import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from './contract';
import { useResendExpired } from './use-resend-window';
type Command<Input> = Readonly<{ body: Input; uncertain: boolean }> &
  CommandKey;
/** Exact commands survive ambiguous responses only within the server receipt window. */
export function useRetainedCommand<Input, Output>(
  execute: (body: Input, key: string) => Promise<Output>,
  onSuccess?: (result: Output, body: Input) => void | Promise<void>,
  options: Readonly<{ action?: string; expiredMessage?: string }> = {},
) {
  const intent = useRef<Command<Input> | undefined>(undefined);
  const busy = useRef(false);
  const [held, setHeld] = useState<CommandKey>();
  const uncertain = held !== undefined;
  const expired = useResendExpired(held);
  const mutation = useMutation({
    mutationFn: (command: Command<Input>) =>
      execute(command.body, command.idempotencyKey),
    retry: false,
    onSuccess: async (result, command) => {
      intent.current = undefined;
      setHeld(undefined);
      await onSuccess?.(result, command.body);
    },
    onError: (error, command) => {
      if (command.uncertain || isUnconfirmedCommand(error)) {
        intent.current = { ...command, uncertain: true };
        setHeld(command);
      } else intent.current = undefined;
    },
  });
  async function send(body: Input) {
    if (busy.current) return;
    const retained = intent.current;
    if (
      retained !== undefined &&
      (canonicalJson(retained.body) !== canonicalJson(body) ||
        !canResend(retained))
    )
      return;
    const command = retained ?? {
      body: structuredClone(body),
      ...newCommandKey(),
      uncertain: false,
    };
    intent.current = command;
    busy.current = true;
    try {
      await mutation.mutateAsync(command);
    } catch {
      /* The caller owns visible feedback. */
    } finally {
      busy.current = false;
    }
  }
  function errorMessage(): string | undefined {
    if (expired) return options.expiredMessage ?? RETRY_WINDOW_ENDED;
    if (uncertain)
      return 'We couldn’t confirm the result. Retry the same action before changing anything.';
    if (mutation.isError)
      return describeCommandError(
        mutation.error,
        options.action ?? 'sending this response',
      );
    return undefined;
  }
  return {
    send,
    pending: mutation.isPending,
    uncertain,
    expired,
    data: mutation.data,
    cause: mutation.error,
    error: errorMessage(),
    retry: () => {
      if (intent.current !== undefined) void send(intent.current.body);
    },
    reset: () => {
      if (!busy.current && intent.current === undefined) mutation.reset();
    },
  };
}
