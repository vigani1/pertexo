import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/contract';
import { useRef } from 'react';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';

/** Either the key to send, or why nothing may be sent yet. */
export type CommandAttemptStart =
  | (Readonly<{ kind: 'send' }> & CommandKey)
  | Readonly<{ kind: 'refused'; message: string }>;

export type CommandAttemptStore = Readonly<{
  begin: (scope: string, intent: string) => CommandAttemptStart;
  complete: (scope: string, intent: string) => void;
  resolveObserved: (scope: string, intent: string) => void;
}>;

const UNRESOLVED =
  'An earlier change is still unconfirmed. Retry it, or refresh until its result shows, before making a different change.';

/**
 * One idempotency key per scope and intent. A different intent is refused
 * while an earlier attempt in the same scope is still unconfirmed; once that
 * attempt's retry window ends it is refused once, then forgotten.
 */
export function useCommandAttemptKeys(): CommandAttemptStore {
  const commands = useRef(
    new Map<string, Readonly<{ intent: string }> & CommandKey>(),
  );
  const forget = (scope: string, intent: string) => {
    if (commands.current.get(scope)?.intent === intent)
      commands.current.delete(scope);
  };
  return {
    begin: (scope, intent) => {
      const existing = commands.current.get(scope);
      if (existing !== undefined && !canResend(existing)) {
        commands.current.delete(scope);
        return { kind: 'refused', message: RETRY_WINDOW_ENDED };
      }
      if (existing !== undefined)
        return existing.intent === intent
          ? { kind: 'send', ...existing }
          : { kind: 'refused', message: UNRESOLVED };
      const command = { intent, ...newCommandKey() };
      commands.current.set(scope, command);
      return { kind: 'send', ...command };
    },
    complete: forget,
    resolveObserved: forget,
  };
}

/** A sentence for a failed settings command, e.g. "turning this schedule off". */
export function settingsCommandError(error: unknown, action: string): string {
  if (isUnconfirmedCommand(error))
    return `We couldn’t confirm whether ${action} went through. Retrying is safe — it repeats the same request.`;
  if (isApiError(error) && (error.status === 409 || error.status === 412))
    return 'This changed in another session. Refresh, then try again.';
  return describeCommandError(error, action);
}
