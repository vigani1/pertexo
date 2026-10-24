import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FederationSettings } from '@pertexo/contracts';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import { useNow } from '@/lib/hooks/use-now';
import {
  COMMAND_RETRY_WINDOW_MS,
  isUnconfirmedCommand,
} from '@/lib/api/commands/contract';
import { describeCommandError } from '@/lib/api/error-copy';
import { isApiError } from '@/lib/api/error';
import {
  applyFederationCommand,
  type FederationCommand,
  type FederationScope,
} from './settings.api';
import { federationSettingsQueryOptions } from './settings.queries';
type Intent = Readonly<{
  operation: FederationCommand;
  key: string;
  createdAt: number;
}>;
/** Provider secrets stay in this mounted form's memory, never in Query's mutation cache. */
export function useFederationCommand(
  scope: FederationScope,
  onApplied?: (settings: FederationSettings) => void,
) {
  const cache = useQueryClient(),
    requests = useLatestRequest(),
    busy = useRef(false),
    intent = useRef<Intent | undefined>(undefined);
  const [error, setError] = useState<string>(),
    [uncertainSince, setUncertainSince] = useState<number>();
  const until =
    uncertainSince === undefined
      ? undefined
      : uncertainSince + COMMAND_RETRY_WINDOW_MS;
  const now = useNow({
      intervalMs: 1000,
      enabled: uncertainSince !== undefined,
      untilMs: until,
    }),
    expired = until !== undefined && now >= until;
  async function execute(command: Intent): Promise<boolean> {
    if (
      busy.current ||
      Date.now() >= command.createdAt + COMMAND_RETRY_WINDOW_MS
    )
      return false;
    busy.current = true;
    const attempt = requests.begin();
    setError(undefined);
    try {
      const result = await applyFederationCommand(
        scope,
        command.operation,
        command.key,
        attempt.signal,
      );
      if (!attempt.isCurrent()) return false;
      intent.current = undefined;
      setUncertainSince(undefined);
      cache.setQueryData(
        federationSettingsQueryOptions(scope).queryKey,
        result,
      );
      onApplied?.(result);
      return true;
    } catch (cause: unknown) {
      if (!attempt.isCurrent()) return false;
      if (isUnconfirmedCommand(cause)) {
        setUncertainSince(command.createdAt);
        setError(
          'The result could not be confirmed. Retry this exact request before changing the form.',
        );
      } else {
        intent.current = undefined;
        setUncertainSince(undefined);
        setError(
          isApiError(cause) &&
            [
              'request.invalid',
              'workspace.conflict',
              'auth.forbidden',
            ].includes(cause.problem?.code ?? '') &&
            cause.problem?.detail !== undefined
            ? cause.problem.detail
            : describeCommandError(cause, 'saving organization sign-in'),
        );
      }
      return false;
    } finally {
      busy.current = false;
      attempt.finish();
    }
  }
  return {
    pending: requests.pending,
    uncertain: uncertainSince !== undefined,
    expired,
    error: expired
      ? 'The request retry window ended. Check settings before starting a new request.'
      : error,
    send: (operation: FederationCommand) => {
      if (intent.current !== undefined) return Promise.resolve(false);
      const command = {
        operation: structuredClone(operation),
        key: crypto.randomUUID(),
        createdAt: Date.now(),
      };
      intent.current = command;
      return execute(command);
    },
    retry: () =>
      intent.current === undefined
        ? Promise.resolve(false)
        : execute(intent.current),
    reset: () => {
      if (!busy.current && intent.current === undefined) setError(undefined);
    },
  };
}
export type FederationCommandState = ReturnType<typeof useFederationCommand>;
