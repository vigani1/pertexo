import {
  isUnauthenticated,
  currentUserQueryKey,
} from '@/features/auth/session/auth-session-queries.public';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { hashKey, type QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { PagePending } from '../routes/root/status/pending';
import { routeTree } from '../routes/root/route-tree';

export function createAppRouter(
  queryClient: QueryClient,
  apiClient: ApiClient,
  history?: RouterHistory,
) {
  let revalidate: () => void = () => undefined;
  const router = createRouter({
    routeTree,
    context: {
      queryClient,
      apiClient,
      onSessionExpired: () => {
        revalidate();
      },
    },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    // A page's skeleton appears only if loading takes longer than 150 ms,
    // and it fades in (skeleton-wait), so it needs no minimum time on
    // screen: a page that lands just after the session check replaces a
    // barely-visible skeleton instead of waiting out 300 ms of one.
    defaultPendingMs: 150,
    defaultPendingMinMs: 0,
    defaultPendingComponent: PagePending,
    scrollRestoration: true,
    ...(history ? { history } : {}),
  });
  // A read warmed without holding navigation found the session gone:
  // reloading the current matches re-runs the workspace's session check,
  // which signs out and sends the person to sign in.
  let recovering = false;
  revalidate = () => {
    if (recovering) return;
    recovering = true;
    const editorIsOpen = router.state.matches.some(
      (match) => match.routeId === '/w/$workspaceId/workflows/$workflowId',
    );
    // The mounted editor observes this query and pauses without losing its draft.
    const recovery = editorIsOpen
      ? queryClient.refetchQueries({
          queryKey: currentUserQueryKey,
          exact: true,
        })
      : router.invalidate();
    void recovery.finally(() => {
      recovering = false;
    });
  };
  queryClient.getQueryCache().subscribe((event) => {
    // The initial session loader owns its own redirect; invalidating it here would cancel that redirect.
    if (
      event.type === 'updated' &&
      event.query.queryHash === hashKey(currentUserQueryKey) &&
      event.query.state.data === undefined
    )
      return;

    if (
      event.type === 'updated' &&
      event.action.type === 'error' &&
      isUnauthenticated(event.action.error)
    )
      revalidate();
  });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  interface StaticDataRouteOption {
    /** The page's name in the workspace breadcrumb. */
    crumb?: string;
  }
}
