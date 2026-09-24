import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { workspaceIdentifierSchema } from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';
import {
  currentUserQueryOptions,
  isUnauthenticated,
} from '@/features/auth/session.queries.public';
import { publishSessionChange } from '@/features/auth/session-sync.public';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';

export type RouterContext = Readonly<{
  queryClient: QueryClient;
  apiClient: ApiClient;
}>;

export function rethrowError(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new Error('An unexpected route failure occurred.', { cause: error });
}

async function clearAuthenticatedQueries(context: RouterContext) {
  await context.queryClient.cancelQueries();
  context.queryClient.clear();
}

/** Ends the local session view and sends the person to sign in. */
async function signOutLocally(context: RouterContext): Promise<never> {
  await clearAuthenticatedQueries(context);
  redirect({ to: '/login', throw: true });
  throw new Error('The sign-in redirect did not interrupt the route.');
}

export async function loadCurrentUser(context: RouterContext) {
  const options = currentUserQueryOptions(context.apiClient);
  const previous = context.queryClient.getQueryData(options.queryKey);
  try {
    const current = await context.queryClient.query(options);
    if (previous !== undefined && previous.id !== current.id) {
      await clearAuthenticatedQueries(context);
      context.queryClient.setQueryData(options.queryKey, current);
      publishSessionChange();
    }
    return current;
  } catch (error) {
    if (isUnauthenticated(error)) return signOutLocally(context);
    return rethrowError(error);
  }
}

/** Resolves the signed-in person or `undefined` without redirecting. */
export async function findCurrentUser(context: RouterContext) {
  try {
    return await context.queryClient.query(
      currentUserQueryOptions(context.apiClient),
    );
  } catch (error) {
    if (isUnauthenticated(error)) {
      await clearAuthenticatedQueries(context);
      return undefined;
    }
    return rethrowError(error);
  }
}

export async function loadWorkspaces(context: RouterContext, userId: string) {
  try {
    return await context.queryClient.query(
      accessibleWorkspacesQueryOptions(context.apiClient, userId),
    );
  } catch (error) {
    if (isUnauthenticated(error)) return signOutLocally(context);
    return rethrowError(error);
  }
}

export async function findWorkspace(
  context: RouterContext,
  userId: string,
  workspaceId: string,
) {
  const parsed = workspaceIdentifierSchema.safeParse(workspaceId);
  if (!parsed.success) return null;
  const workspaces = await loadWorkspaces(context, userId);
  return workspaces.find((candidate) => candidate.id === parsed.data) ?? null;
}

/**
 * Settles route prefetches. An expired session always signs out locally.
 * `tolerate` lets the page render its own recovery for other failures;
 * `strict` rethrows the first one to the route error boundary.
 */
export async function settlePrefetches(
  context: RouterContext,
  reads: readonly Promise<unknown>[],
  mode: 'tolerate' | 'strict' = 'tolerate',
): Promise<void> {
  const results = await Promise.allSettled(reads);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.some(isUnauthenticated)) await signOutLocally(context);
  const [first] = failures;
  if (mode === 'strict' && first !== undefined) rethrowError(first);
}
