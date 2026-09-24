import { redirect } from '@tanstack/react-router';
import { workspaceIdentifierSchema } from '@pertexo/contracts/schemas/identity-workspace';
import {
  currentUserQueryOptions,
  isUnauthenticated,
} from '@/features/auth/session.queries.public';
import { publishSessionChange } from '@/features/auth/session-sync.public';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';
import type { RouterContext } from './root-route';

export function rethrowError(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new Error('An unexpected route failure occurred.', { cause: error });
}

export async function clearAuthenticatedQueries(
  context: RouterContext,
): Promise<void> {
  await context.queryClient.cancelQueries();
  context.queryClient.clear();
}

/**
 * Sends a loader whose read failed because the session ended back to login
 * after clearing identity-scoped cache. Other failures stay with the caller.
 */
export async function redirectWhenUnauthenticated(
  context: RouterContext,
  error: unknown,
): Promise<void> {
  if (!isUnauthenticated(error)) return;
  await clearAuthenticatedQueries(context);
  redirect({ to: '/login', throw: true });
}

/** Settled-read variant: any read rejected by an ended session redirects. */
export async function redirectWhenAnyUnauthenticated(
  context: RouterContext,
  results: readonly PromiseSettledResult<unknown>[],
): Promise<void> {
  if (
    results.some(
      (result) =>
        result.status === 'rejected' &&
        isUnauthenticated(result.reason as unknown),
    )
  ) {
    await clearAuthenticatedQueries(context);
    redirect({ to: '/login', throw: true });
  }
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
    await redirectWhenUnauthenticated(context, error);
    rethrowError(error);
  }
}

export async function loadWorkspaces(context: RouterContext, userId: string) {
  try {
    return await context.queryClient.query(
      accessibleWorkspacesQueryOptions(context.apiClient, userId),
    );
  } catch (error) {
    await redirectWhenUnauthenticated(context, error);
    rethrowError(error);
  }
}

export async function loadWorkspace(
  context: RouterContext,
  userId: string,
  workspaceId: string,
) {
  const parsedWorkspaceId = workspaceIdentifierSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) return null;
  const workspaces = await loadWorkspaces(context, userId);
  return (
    workspaces.find((candidate) => candidate.id === parsedWorkspaceId.data) ??
    null
  );
}
