import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FederationSettings } from '@pertexo/contracts';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import {
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/contract';
import { useResendExpired } from '@/lib/api/commands/use-resend-window';
import { describeCommandError } from '@/lib/api/error-copy';
import { isApiError } from '@/lib/api/error';
import {
  applyFederationCommand,
  type FederationCommand,
  type FederationScope,
} from './settings.api';
import { federationSettingsQueryOptions } from './settings.queries';
type Intent = Readonly<{ operation: FederationCommand }> & CommandKey;
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
    [held, setHeld] = useState<Intent>();
  const expired = useResendExpired(held);
  async function execute(command: Intent): Promise<boolean> {
    if (busy.current || !canResend(command)) return false;
    busy.current = true;
    const attempt = requests.begin();
    setError(undefined);
    try {
      const result = await applyFederationCommand(
        scope,
        command.operation,
        command.idempotencyKey,
        attempt.signal,
      );
      if (!attempt.isCurrent()) return false;
      intent.current = undefined;
      setHeld(undefined);
      cache.setQueryData(
        federationSettingsQueryOptions(scope).queryKey,
        result,
      );
      onApplied?.(result);
      return true;
    } catch (cause: unknown) {
      if (!attempt.isCurrent()) return false;
      if (isUnconfirmedCommand(cause)) {
        setHeld(command);
        setError(
          'The result could not be confirmed. Retry this exact request before changing the form.',
        );
      } else {
        intent.current = undefined;
        setHeld(undefined);
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
    uncertain: held !== undefined,
    expired,
    error: expired
      ? 'The request retry window ended. Check settings before starting a new request.'
      : error,
    send: (operation: FederationCommand) => {
      if (intent.current !== undefined) return Promise.resolve(false);
      const command = {
        operation: structuredClone(operation),
        ...newCommandKey(),
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
