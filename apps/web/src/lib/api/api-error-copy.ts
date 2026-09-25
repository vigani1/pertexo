import { isApiError } from './api-error';

// Generic, human wording for failures every feature shares. Features keep
// their own messages for domain-specific codes and fall back to these.

/** The request may or may not have been applied; retry with the same key. */
export function isUncertainOutcome(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'protocol')
  );
}

export function isForbidden(error: unknown): boolean {
  return isApiError(error) && error.status === 403;
}

export function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

function isWritePaused(error: unknown): boolean {
  return isApiError(error) && error.problem?.code === 'platform.write_paused';
}

/** Whole seconds to wait before retrying a rate-limited request. */
export function retryAfterSeconds(error: unknown): number | undefined {
  if (!isApiError(error) || error.retryAfterMs === undefined) return undefined;
  return Math.max(1, Math.ceil(error.retryAfterMs / 1000));
}

/** The request ID people can quote to support, when the API returned one. */
export function supportReference(error: unknown): string | undefined {
  return isApiError(error) ? error.requestId : undefined;
}

/** A sentence for a failed read, e.g. `describeReadError(error, 'Runs')`. */
export function describeReadError(error: unknown, resource: string): string {
  if (isApiError(error)) {
    if (error.status === 403)
      return `Your role no longer has access to ${resource.toLowerCase()} here.`;
    if (error.kind === 'network')
      return `${resource} couldn’t be reached. Check your connection and try again.`;
    if (error.kind === 'timeout')
      return `${resource} took too long to load. Try again.`;
    const seconds = retryAfterSeconds(error);
    if (error.status === 429 && seconds !== undefined)
      return `Too many requests. Try again in ${String(seconds)} s.`;
  }
  return `${resource} couldn’t be loaded. Try again.`;
}

/** A sentence for a failed command whose domain codes the caller handled. */
export function describeCommandError(error: unknown, action: string): string {
  if (isUncertainOutcome(error))
    return `We couldn’t confirm whether ${action} went through. Check again before retrying.`;
  if (isWritePaused(error))
    return 'Pertexo is in read-only maintenance. Try again shortly.';
  if (isForbidden(error)) return `Your role doesn’t allow ${action}.`;
  if (
    isApiError(error) &&
    error.problem?.code === 'request.idempotency_conflict'
  )
    return 'This request was already used with different details. Try again.';
  const seconds = retryAfterSeconds(error);
  if (isApiError(error) && error.status === 429 && seconds !== undefined)
    return `Too many attempts. Try again in ${String(seconds)} s.`;
  const Action = `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  if (isApiError(error) && error.status === 503)
    return `${Action} isn’t available right now. Nothing was changed; try again in a few minutes.`;
  const reference = supportReference(error);
  if (
    isApiError(error) &&
    (error.status ?? 0) >= 500 &&
    reference !== undefined
  )
    return `${Action} didn’t work on our side. Try again; if it keeps happening, quote reference ${reference.slice(0, 8)}.`;
  return `${Action} didn’t work. Try again.`;
}
