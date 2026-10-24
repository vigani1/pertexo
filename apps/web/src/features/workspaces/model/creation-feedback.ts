import { isApiError } from '@/lib/api/error';

export type CreationError = Readonly<{
  field?: 'slug';
  message: string;
}>;

export function isUncertain(error: unknown) {
  return (
    isApiError(error) &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'protocol')
  );
}

export function creationError(error: unknown): CreationError {
  if (isApiError(error)) {
    if (error.problem?.code === 'workspace.conflict')
      return {
        field: 'slug',
        message: 'That handle is already taken. Choose another one.',
      };
    if (error.problem?.code === 'request.idempotency_conflict')
      return {
        message:
          'These details changed since the last attempt. Start over to create the workspace.',
      };
    if (error.status === 403)
      return {
        message: 'Your account isn’t allowed to create workspaces.',
      };
    if (error.status === 400)
      return {
        message:
          'Pertexo didn’t accept these details. Check the name and handle.',
      };
  }
  return { message: 'The workspace couldn’t be created. Try again.' };
}
