import { lowEffectError } from '@/lib/api/commands/low-effect-mutation';
import { isApiError } from '@/lib/api/error';

export type RenameError = Readonly<{
  kind: 'conflict' | 'other';
  message: string;
}>;
export const CONFLICT: RenameError = {
  kind: 'conflict',
  message: 'This workspace changed while you were editing.',
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

export function renameFailure(error: unknown): RenameError {
  const code = isApiError(error) ? error.problem?.code : undefined;
  if (code === 'workspace.revision_conflict') return CONFLICT;
  if (code === 'workspace.conflict')
    return {
      kind: 'other',
      message: 'Only an active workspace can be renamed.',
    };
  return {
    kind: 'other',
    message: lowEffectError(error, 'renaming the workspace'),
  };
}
