import { isApiError } from '@/lib/api/error';

// An ended session isn't a loss here: the session pause keeps the page.
export type AccessLoss = 'permission';

/**
 * Whether a team read failed because access went away. A missing member list
 * is a server fault, but a missing invitation list means the role lost it.
 */
export function lossOf({
  query,
  notFoundIsLoss,
}: Readonly<{
  query: Readonly<{ isError: boolean; error: unknown }>;
  notFoundIsLoss: boolean;
}>): AccessLoss | undefined {
  if (!query.isError) return undefined;
  const error = query.error;
  if (!isApiError(error)) return undefined;
  if (error.status === 403 || (notFoundIsLoss && error.status === 404))
    return 'permission';
  return undefined;
}
