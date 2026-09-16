import { isApiError } from '@/lib/api/api-error';

export function connectionListErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 403)
      return 'You no longer have access to connections in this workspace.';
    if (error.kind === 'network')
      return 'Connections could not be reached. Check your network and try again.';
    if (error.kind === 'timeout')
      return 'Connection loading took too long. Try again.';
  }
  return 'Connections could not be loaded. Try again.';
}

export function connectionCreateErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 403)
      return 'Your role does not allow connection creation.';
    if (error.status === 409)
      return 'That request conflicts with an existing connection command.';
    if (error.kind === 'network' || error.kind === 'timeout')
      return 'The result is uncertain. Retry without changing these values to safely reuse this request.';
  }
  return 'The connection could not be created. Check the values and try again.';
}

function isUncertain(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'protocol')
  );
}

export function connectionTestErrorMessage(error: unknown): string {
  if (isUncertain(error))
    return 'The test result is uncertain. Retry to observe the same test command.';
  if (isApiError(error)) {
    if (error.problem?.code === 'connection.reauthorization_required')
      return 'This connection needs new credentials before it can be tested.';
    if (error.status === 403)
      return 'Your role no longer allows connection testing.';
    if (error.status === 429)
      return 'Connection tests are temporarily limited. Wait and try again.';
  }
  return 'The connection test could not be completed.';
}

export function connectionRotateErrorMessage(error: unknown): string {
  if (isUncertain(error))
    return 'The rotation result is uncertain. Retry without changing the token to reuse this command safely.';
  if (isApiError(error)) {
    if (error.status === 403)
      return 'Your role no longer allows credential rotation.';
    if (error.status === 409)
      return 'The credentials changed. Close this dialog, refresh, and try again.';
  }
  return 'The credentials could not be rotated. Check the token and try again.';
}

export function connectionRevokeErrorMessage(error: unknown): string {
  if (isUncertain(error))
    return 'The revoke result is uncertain. Refresh the connection list before deciding whether to try again.';
  if (isApiError(error) && error.status === 403)
    return 'Your role no longer allows connection revocation.';
  return 'The connection could not be revoked.';
}
