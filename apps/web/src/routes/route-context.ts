import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { workspaceIdentifierSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { isNotFound } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import {
  currentUserQueryOptions,
  isUnauthenticated,
} from '@/features/auth/queries.public';
import { publishSessionChange } from '@/features/auth/session-sync.public';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import { connectionDiscoveryQueryOptions } from '@/features/connections/queries.public';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';

export type RouterContext = Readonly<{
  queryClient: QueryClient;
  apiClient: ApiClient;
  /** Re-runs the current routes' session checks after a warmed read's 401. */
  onSessionExpired: () => void;
}>;

function rethrowError(error: unknown): never {
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
 * Starts a page's reads without holding navigation: the page renders at once
 * and each block shows its own skeleton, retrying on mount if its read
 * failed. An expired session found here re-runs the route's session check,
 * which signs out, so a warmed read keeps the loader's sign-in guarantee.
 */
export function warmPrefetches(
  context: RouterContext,
  reads: readonly Promise<unknown>[],
): void {
  void Promise.allSettled(reads).then((results) => {
    if (
      results.some(
        (result) =>
          result.status === 'rejected' && isUnauthenticated(result.reason),
      )
    )
      context.onSessionExpired();
  });
}

/** The step catalog and connections every workflow-building page reads. */
export function authoringPrefetches(
  context: RouterContext,
  userId: string,
  workspaceId: string,
): readonly Promise<unknown>[] {
  const { apiClient, queryClient } = context;
  return [
    queryClient.query(authoringCatalogQueryOptions(apiClient, userId)),
    queryClient.query(
      connectionDiscoveryQueryOptions(apiClient, userId, workspaceId),
    ),
  ];
}

async function settleReads(
  context: RouterContext,
  reads: readonly Promise<unknown>[],
): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(reads);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  // An expired session always signs out, whatever else failed.
  if (failures.some(isUnauthenticated)) await signOutLocally(context);
  return failures;
}

/**
 * Holds navigation until one resource's page has its data. A 404 (missing,
 * or hidden by the API's non-disclosing policy) renders the in-shell
 * not-found page; any other failure goes to the route error boundary.
 */
export async function prefetchResource(
  context: RouterContext,
  reads: readonly Promise<unknown>[],
): Promise<Readonly<{ found: boolean }>> {
  const [first] = await settleReads(context, reads);
  if (first === undefined) return { found: true };
  if (isNotFound(first)) return { found: false };
  return rethrowError(first);
}

/**
 * Asks only whether a resource exists before its pages render: a 404 means
 * not found and an expired session signs out, while any other failure is
 * left to the pages, which show their own recovery.
 */
export async function probeResource(
  context: RouterContext,
  read: Promise<unknown>,
): Promise<Readonly<{ found: boolean }>> {
  const failures = await settleReads(context, [read]);
  return { found: !failures.some(isNotFound) };
}
