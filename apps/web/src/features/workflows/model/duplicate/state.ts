import { isApiError } from '@/lib/api/error';
import { describeCommandError, isUncertainOutcome } from '@/lib/api/error-copy';

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
        (phase === 'mutation' && isUncertainOutcome(error))));
  if (retainCommand)
    return {
      ...current,
      kind: 'uncertain',
      error:
        phase === 'accepted'
          ? 'The copy was created, but access couldn’t be reverified. Retry to verify access and open that existing copy.'
          : 'We couldn’t confirm whether the copy was created. Retry the exact command to recover it. Recovery is limited by receipt retention; check existing workflows before making a new copy.',
    };
  return {
    ...current,
    kind: stale ? 'stale' : 'ready',
    error: stale
      ? 'The saved source changed. This retry did not create a copy; an older copy may still exist if its receipt expired. Check existing workflows, read the current saved draft, then confirm a new copy explicitly.'
      : describeCommandError(error, 'duplicating this workflow'),
  };
}
