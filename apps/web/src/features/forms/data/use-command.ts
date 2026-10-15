import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { canonicalJson } from '@pertexo/workflow-model';
import { describeCommandError, isUncertainOutcome } from '@/lib/api/error-copy';
/** Exact commands survive lost responses; a later choice never reuses their keys. */
export function useFormCommand<Input, Output>(
  execute: (body: Input, key: string) => Promise<Output>,
  onSuccess?: (result: Output, body: Input) => void | Promise<void>,
) {
  const intent = useRef<Readonly<{ body: Input; key: string }> | undefined>(
    undefined,
  );
  const busy = useRef(false);
  const mutation = useMutation({
    mutationFn: (command: Readonly<{ body: Input; key: string }>) =>
      execute(command.body, command.key),
    retry: false,
    onSuccess: async (result, command) => {
      intent.current = undefined;
      await onSuccess?.(result, command.body);
    },
    onError: (error) => {
      if (!isUncertainOutcome(error)) intent.current = undefined;
    },
  });
  async function send(body: Input) {
    if (busy.current) return;
    if (
      intent.current !== undefined &&
      canonicalJson(intent.current.body) !== canonicalJson(body)
    )
      return;
    const command = intent.current ?? {
      body: structuredClone(body),
      key: crypto.randomUUID(),
    };
    intent.current = command;
    busy.current = true;
    try {
      await mutation.mutateAsync(command);
    } catch {
      /* The caller renders the one visible error. */
    } finally {
      busy.current = false;
    }
  }
  const uncertain = mutation.isError && isUncertainOutcome(mutation.error);
  return {
    send,
    pending: mutation.isPending,
    uncertain,
    data: mutation.data,
    cause: mutation.error,
    error: mutation.isError
      ? uncertain
        ? 'We couldn’t confirm the result. Retry the same action before changing anything.'
        : describeCommandError(mutation.error, 'sending this response')
      : undefined,
    retry: () => {
      if (intent.current !== undefined) void send(intent.current.body);
    },
    reset: () => {
      if (!busy.current && intent.current === undefined) mutation.reset();
    },
  };
}
