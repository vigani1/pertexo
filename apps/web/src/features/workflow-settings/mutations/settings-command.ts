import { useRef } from 'react';
import { isApiError } from '@/lib/api/api-error';

export type CommandAttemptStore = Readonly<{
  begin: (
    scope: string,
    intent: string,
  ) => Readonly<{ key: string; exactRetry: boolean }> | undefined;
  complete: (scope: string, intent: string) => void;
  resolveObserved: (scope: string, intent: string) => void;
}>;

export function useCommandAttemptKeys(): CommandAttemptStore {
  const commands = useRef(
    new Map<string, Readonly<{ intent: string; key: string }>>(),
  );
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
    complete: (scope, intent) => {
      if (commands.current.get(scope)?.intent === intent)
        commands.current.delete(scope);
    },
    resolveObserved: (scope, intent) => {
      if (commands.current.get(scope)?.intent === intent)
        commands.current.delete(scope);
    },
  };
}

export const unresolvedCommandMessage =
  'Resolve the earlier uncertain command by retrying it or refreshing until its result is visible before issuing a different command.';

export function isUncertainSettingsCommand(error: unknown): boolean {
  return (
    isApiError(error) && ['network', 'timeout', 'protocol'].includes(error.kind)
  );
}

export function settingsCommandError(error: unknown, action: string): string {
  if (isUncertainSettingsCommand(error))
    return `The result is uncertain. Retry to ${action} with the same command key.`;
  if (isApiError(error) && (error.status === 409 || error.status === 412))
    return 'This resource changed. Refresh the section before trying again.';
  if (isApiError(error) && error.status === 403)
    return `You no longer have permission to ${action}.`;
  return `Could not ${action}.`;
}
