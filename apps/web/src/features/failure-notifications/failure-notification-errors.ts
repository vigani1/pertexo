import { isApiError } from '@/lib/api/api-error';

export function destinationListErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 401 || error.status === 403 || error.status === 404)
      return 'Notification destinations are unavailable for this workspace or session.';
    if (error.kind === 'network')
      return 'Notification destinations could not be reached. Check your network and try again.';
    if (error.kind === 'timeout')
      return 'Notification destinations took too long to load. Try again.';
  }
  return 'Notification destinations could not be loaded. Try again.';
}

export function destinationCommandErrorMessage(
  error: unknown,
  action: string,
): string {
  if (
    isApiError(error) &&
    ['network', 'timeout', 'protocol'].includes(error.kind)
  )
    return `The result is uncertain. Retry to ${action} with the same command.`;
  if (isApiError(error) && (error.status === 409 || error.status === 412))
    return 'This destination changed. Close the dialog, refresh, and try again.';
  if (isApiError(error) && (error.status === 403 || error.status === 404))
    return `You no longer have permission to ${action}.`;
  return `Could not ${action}. Check the values and try again.`;
}
