import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { canonicalJson } from '@pertexo/workflow-model';
import { describeCommandError } from '../error-copy';
import { isApiError } from '../error';
import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from './command-retry';
import { useResendExpired } from './use-resend-window';
type Command<Input> = Readonly<{ body: Input; uncertain: boolean }> &
  CommandKey;
/** Exact commands survive ambiguous responses only within the server receipt window. */
export function useRetainedCommand<Input, Output>(
  execute: (body: Input, key: string) => Promise<Output>,
  onSuccess?: (result: Output, body: Input) => void | Promise<void>,
  options: Readonly<{
    action?: string;
    expiredMessage?: string;
    onRefused?: (cause: unknown) => Promise<void>;
    failureMessage?: (cause: unknown) => string | undefined;
  }> = {},
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
    onError: async (error, command) => {
      if (command.uncertain || isUnconfirmedCommand(error)) {
        intent.current = { ...command, uncertain: true };
        setHeld(command);
      } else {
        intent.current = undefined;
        await options.onRefused?.(error);
      }
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
  // A resend of an unconfirmed command that the server refused for the
  // person's role: the refusal is certain, the first send's fate isn't.
  const refused =
    uncertain && isApiError(mutation.error) && mutation.error.status === 403;
  function errorMessage(): string | undefined {
    if (expired) return options.expiredMessage ?? RETRY_WINDOW_ENDED;
    if (refused)
      return `${refusal()} Pertexo refused this retry; the first attempt’s answer was lost, so check the current state to see whether it saved.`;
    if (uncertain)
      return 'We couldn’t confirm the result. Retry the same action before changing anything.';
    if (mutation.isError) return refusal();
    return undefined;
  }
  function refusal(): string {
    return (
      options.failureMessage?.(mutation.error) ??
      describeCommandError(
        mutation.error,
        options.action ?? 'sending this response',
      )
    );
  }

  return {
    send,
    pending: mutation.isPending,
    uncertain,
    /** The retry of an unconfirmed command was refused for the person's role. */
    refused,
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
