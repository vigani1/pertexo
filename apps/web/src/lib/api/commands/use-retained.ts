import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { canonicalJson } from '@pertexo/workflow-model';
import { describeCommandError } from '../error-copy';
import { COMMAND_RETRY_WINDOW_MS, isUnconfirmedCommand } from './contract';
import { useNow } from '../../hooks/use-now';
type Command<Input> = Readonly<{
  body: Input;
  key: string;
  createdAt: number;
  uncertain: boolean;
}>;
/** Exact commands survive ambiguous responses only within the server receipt window. */
export function useRetainedCommand<Input, Output>(
  execute: (body: Input, key: string) => Promise<Output>,
  onSuccess?: (result: Output, body: Input) => void | Promise<void>,
  options: Readonly<{ action?: string; expiredMessage?: string }> = {},
) {
  const intent = useRef<Command<Input> | undefined>(undefined);
  const busy = useRef(false);
  const [uncertainSince, setUncertainSince] = useState<number>();
  const uncertain = uncertainSince !== undefined;
  const until =
    uncertainSince === undefined
      ? undefined
      : uncertainSince + COMMAND_RETRY_WINDOW_MS;
  const now = useNow({ intervalMs: 1000, enabled: uncertain, untilMs: until });
  const expired = until !== undefined && now >= until;
  const mutation = useMutation({
    mutationFn: (command: Command<Input>) => execute(command.body, command.key),
    retry: false,
    onSuccess: async (result, command) => {
      intent.current = undefined;
      setUncertainSince(undefined);
      await onSuccess?.(result, command.body);
    },
    onError: (error, command) => {
      if (command.uncertain || isUnconfirmedCommand(error)) {
        intent.current = { ...command, uncertain: true };
        setUncertainSince(command.createdAt);
      } else intent.current = undefined;
    },
  });
  async function send(body: Input) {
    if (busy.current) return;
    const retained = intent.current;
    if (
      retained !== undefined &&
      (canonicalJson(retained.body) !== canonicalJson(body) ||
        Date.now() >= retained.createdAt + COMMAND_RETRY_WINDOW_MS)
    )
      return;
    const command = retained ?? {
      body: structuredClone(body),
      key: crypto.randomUUID(),
      createdAt: Date.now(),
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
    if (expired)
      return (
        options.expiredMessage ??
        'This request’s 24-hour retry window has ended. Check its result before starting again.'
      );
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
