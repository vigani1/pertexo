import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import { isUnauthenticated } from '@/features/auth/session/session-identity.public';

export type RenameError = Readonly<{
  kind: 'conflict' | 'other' | 'verification';
  message: string;
}>;
type Failure =
  | Readonly<{ kind: 'signed-out' }>
  | Readonly<{ kind: 'forbidden' }>
  | Readonly<{ kind: 'uncertain' }>
  | Readonly<{ kind: 'rejected'; error: RenameError }>;

export const CONFLICT: RenameError = {
  kind: 'conflict',
  message: 'This workspace changed while you were editing.',
};
export const UNCERTAIN: RenameError = {
  kind: 'other',
  message:
    'We couldn’t confirm whether the rename went through. Try again — it can’t apply twice.',
};
export const UNVERIFIED: RenameError = {
  kind: 'verification',
  message:
    'We couldn’t check your session. Try again — the same rename is kept.',
};
export const NOT_CAUGHT_UP: RenameError = {
  kind: 'other',
  message:
    'The new name is saved, but this page couldn’t catch up. Refresh to see it everywhere.',
};
export const RELOAD_FAILED: RenameError = {
  kind: 'conflict',
  message:
    'Someone changed this workspace meanwhile, and the latest name couldn’t be loaded. Try again.',
};

export function classifyFailure(error: unknown): Failure {
  if (isUnauthenticated(error)) return { kind: 'signed-out' };
  if (isApiError(error) && error.status === 403) return { kind: 'forbidden' };
  if (isUnconfirmedCommand(error)) return { kind: 'uncertain' };
  const code = isApiError(error) ? error.problem?.code : undefined;
  if (code === 'workspace.revision_conflict')
    return { kind: 'rejected', error: CONFLICT };
  if (code === 'request.idempotency_conflict')
    return {
      kind: 'rejected',
      error: {
        kind: 'other',
        message:
          'This request was already used with different details. Try again.',
      },
    };
  if (code === 'workspace.conflict')
    return {
      kind: 'rejected',
      error: {
        kind: 'other',
        message: 'Only an active workspace can be renamed.',
      },
    };
  return {
    kind: 'rejected',
    error: {
      kind: 'other',
      message: describeCommandError(error, 'renaming the workspace'),
    },
  };
}
