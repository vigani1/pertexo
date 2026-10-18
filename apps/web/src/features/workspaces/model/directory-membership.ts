import { isApiError } from '@/lib/api/error';

export function directoryMembershipFeedback(
  cause: unknown,
): string | undefined {
  return isApiError(cause) &&
    cause.problem?.code === 'workspace.member_directory_managed'
    ? 'The organization directory controls this membership. Ask its control workspace owner to change access.'
    : undefined;
}
