import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';

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
): DuplicateState {
  if (isUncertainOutcome(error))
    return {
      ...current,
      kind: 'uncertain',
      error:
        'We couldn’t confirm whether the copy was created. Retry the exact command safely; it won’t create a second copy.',
    };
  const stale = isApiError(error) && error.status === 412;
  return {
    ...current,
    kind: stale ? 'stale' : 'ready',
    error: stale
      ? 'The saved source changed. Read the current saved draft, then confirm a new copy explicitly.'
      : describeCommandError(error, 'duplicating this workflow'),
  };
}
