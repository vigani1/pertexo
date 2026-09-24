import { useRef } from 'react';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';

export type CommandAttemptStore = Readonly<{
  begin: (
    scope: string,
    intent: string,
  ) => Readonly<{ key: string; exactRetry: boolean }> | undefined;
  complete: (scope: string, intent: string) => void;
  resolveObserved: (scope: string, intent: string) => void;
}>;

/**
 * One idempotency key per scope and intent. A different intent is refused
 * while an earlier attempt in the same scope is still unconfirmed.
 */
export function useCommandAttemptKeys(): CommandAttemptStore {
  const commands = useRef(
    new Map<string, Readonly<{ intent: string; key: string }>>(),
  );
  const forget = (scope: string, intent: string) => {
    if (commands.current.get(scope)?.intent === intent)
      commands.current.delete(scope);
  };
  return {
    begin: (scope, intent) => {
      const existing = commands.current.get(scope);
      if (existing !== undefined)
        return existing.intent === intent
          ? { key: existing.key, exactRetry: true }
          : undefined;
      const key = crypto.randomUUID();
      commands.current.set(scope, { intent, key });
      return { key, exactRetry: false };
    },
    complete: forget,
    resolveObserved: forget,
  };
}

export const unresolvedCommandMessage =
  'An earlier change is still unconfirmed. Retry it, or refresh until its result shows, before making a different change.';

export const isUncertainSettingsCommand = isUncertainOutcome;

/** A sentence for a failed settings command, e.g. "turning this schedule off". */
export function settingsCommandError(error: unknown, action: string): string {
  if (isUncertainOutcome(error))
    return `We couldn’t confirm whether ${action} went through. Retrying is safe — it repeats the same request.`;
  if (isApiError(error) && (error.status === 409 || error.status === 412))
    return 'This changed in another session. Refresh, then try again.';
  return describeCommandError(error, action);
}
