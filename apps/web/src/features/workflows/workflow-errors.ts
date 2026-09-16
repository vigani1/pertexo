import { isApiError } from '@/lib/api/api-error';

export function workflowListErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 403)
      return 'You no longer have access to workflows in this workspace.';
    if (error.kind === 'network')
      return 'Workflows could not be reached. Check your connection and try again.';
    if (error.kind === 'timeout')
      return 'Workflow loading took too long. Try again.';
  }
  return 'Workflows could not be loaded. Try again.';
}

export function workflowCreateErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 403)
      return 'Your role does not allow workflow creation.';
    if (error.status === 409)
      return 'That request conflicts with the current workspace state.';
    if (error.kind === 'network' || error.kind === 'timeout')
      return 'The result is uncertain. Retry without changing the name to safely reuse this request.';
  }
  return 'The workflow could not be created. Try again.';
}
