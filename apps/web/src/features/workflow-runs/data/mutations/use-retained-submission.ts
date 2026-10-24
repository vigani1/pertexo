import { useEffect, useRef, useState } from 'react';
import { useNow } from '@/lib/hooks/use-now';
import {
  isUnconfirmedRunCommand,
  RUN_COMMAND_WINDOW_MS,
  RUN_COMMAND_EXPIRED_MESSAGE,
} from '../../model/commands/run';
import type { ApiClient } from '@/lib/api/client';
type Attempt<Intent> = Readonly<{
  intent: Intent;
  normalized: string;
  key: string;
  createdAt: number;
  owner: symbol;
}>;
/** A retained command is one deliberate intent, even when its response is lost. */
export function useRetainedSubmission<Intent>({
  apiClient,
  userId,
  workspaceId,
  sourceRunId,
  workflowVersionId,
  normalize,
  send,
  describeError,
  onAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  sourceRunId: string;
  workflowVersionId: string;
  normalize: (intent: Intent) => string;
  send: (intent: Intent, key: string) => Promise<string>;
  describeError: (cause: unknown) => string;
  onAccepted: (runId: string) => void;
}>) {
  const owner = useRef<symbol | undefined>(undefined);
  const active = useRef<symbol | undefined>(undefined);
  const attempt = useRef<Attempt<Intent> | undefined>(undefined);
  const [inFlight, setInFlight] = useState<symbol>();
  const [error, setError] = useState<string>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number>();
  const now = useNow({
    intervalMs: 1_000,
    enabled: unconfirmed,
    untilMs: expiresAt,
  });
  const expired = unconfirmed && expiresAt !== undefined && now >= expiresAt;
  useEffect(() => {
    const current = Symbol('run-command');
    owner.current = current;
    return () => {
      if (owner.current === current) owner.current = undefined;
    };
  }, [apiClient, userId, workspaceId, sourceRunId, workflowVersionId]);
  async function submit(command: Attempt<Intent>) {
    const currentOwner = owner.current;
    if (
      currentOwner === undefined ||
      command.owner !== currentOwner ||
      active.current !== undefined
    )
      return false;
    const submission = Symbol('submission');
    active.current = submission;
    setInFlight(submission);
    setError(undefined);
    attempt.current = command;
    setExpiresAt(command.createdAt + RUN_COMMAND_WINDOW_MS);
    let accepted: string;
    try {
      accepted = await send(command.intent, command.key);
    } catch (cause) {
      if (owner.current !== currentOwner) return false;
      const uncertain = unconfirmed || isUnconfirmedRunCommand(cause);
      if (!uncertain) attempt.current = undefined;
      setUnconfirmed(uncertain);
      setError(describeError(cause));
      return false;
    } finally {
      if (active.current === submission) active.current = undefined;
      setInFlight((current) => (current === submission ? undefined : current));
    }
    if (owner.current !== currentOwner) return false;
    attempt.current = undefined;
    setUnconfirmed(false);
    onAccepted(accepted);
    return true;
  }
  function startNew(intent: Intent) {
    if (
      attempt.current !== undefined &&
      attempt.current.owner !== owner.current
    ) {
      attempt.current = undefined;
      setUnconfirmed(false);
      setExpiresAt(undefined);
    }
    if (active.current !== undefined || attempt.current !== undefined)
      return Promise.resolve(false);
    const currentOwner = owner.current;
    if (currentOwner === undefined) return Promise.resolve(false);
    return submit({
      intent: structuredClone(intent),
      normalized: normalize(intent),
      key: crypto.randomUUID(),
      createdAt: Date.now(),
      owner: currentOwner,
    });
  }
  function retry(intent?: Intent) {
    const current = attempt.current;
    if (current === undefined || active.current !== undefined)
      return Promise.resolve(false);
    if (current.owner !== owner.current) {
      setError(
        'This request belongs to the previous run or signed-in account. Check its run history before starting a new request.',
      );
      return Promise.resolve(false);
    }
    if (Date.now() >= current.createdAt + RUN_COMMAND_WINDOW_MS) {
      setError(RUN_COMMAND_EXPIRED_MESSAGE);
      return Promise.resolve(false);
    }
    if (intent !== undefined && normalize(intent) !== current.normalized) {
      setError('Restore the original values to retry this same request.');
      return Promise.resolve(false);
    }
    return submit(current);
  }
  function dismiss() {
    if (active.current !== undefined || attempt.current !== undefined) return;
    attempt.current = undefined;
    setError(undefined);
  }
  return {
    dismiss,
    error: expired ? RUN_COMMAND_EXPIRED_MESSAGE : error,
    pending: inFlight !== undefined,
    retry,
    retryAvailable: unconfirmed && !expired,
    unconfirmed,
    expired,
    startNew,
  };
}
