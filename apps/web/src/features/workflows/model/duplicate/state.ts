import {
  RETRY_WINDOW_ENDED,
  isUnconfirmedCommand,
} from '@/lib/api/commands/command-retry';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';

export type DuplicatePhase = 'authority' | 'mutation' | 'accepted';

export type DuplicateState = Readonly<{
  kind:
    | 'loading'
    | 'ready'
    | 'sending'
    | 'uncertain'
    | 'stale'
    | 'failed'
    | 'denied';
  draft?: Readonly<{ revision: number; etag: string }>;
  error?: string | undefined;
}>;

/** Ordinary conflicts retain source/name intent; uncertainty retains the exact command. */
export function duplicateFailureState(
  error: unknown,
  current: DuplicateState,
  phase: DuplicatePhase,
): DuplicateState {
  const rejected =
    phase === 'mutation' &&
    isApiError(error) &&
    error.kind === 'problem' &&
    [400, 409, 412, 422, 428].includes(error.status ?? 0);
  const stale = rejected && isApiError(error) && error.status === 412;
  const retainCommand =
    phase === 'accepted' ||
    (!rejected &&
      (current.kind === 'uncertain' ||
        (phase === 'mutation' && isUnconfirmedCommand(error))));
  if (retainCommand)
    return {
      ...current,
      kind: 'uncertain',
      error:
        phase === 'accepted'
          ? 'The copy was created, but access couldn’t be reverified. Retry to verify access and open that existing copy.'
          : 'We couldn’t confirm whether the copy was created. Retry to find it. That stops working after a while, so check your workflows before making a new copy.',
    };
  return {
    ...current,
    kind: stale ? 'stale' : 'ready',
    error: stale
      ? 'The saved source changed, so this retry didn’t make a copy. An older copy may still exist. Check your workflows, read the current draft, then confirm a new copy.'
      : describeCommandError(error, 'duplicating this workflow'),
  };
}

/** A held copy past its retry window: the form is free again, and says why. */
export function duplicateWindowEnded(current: DuplicateState): DuplicateState {
  return { ...current, kind: 'ready', error: RETRY_WINDOW_ENDED };
}
