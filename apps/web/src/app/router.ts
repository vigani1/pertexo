import {
  currentUserQueryKey,
  currentUserQueryOptions,
} from '@/features/auth/session/auth-session-queries.public';
import {
  createRouter,
  isRedirect,
  type RouterHistory,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { createSessionPause } from '@/features/auth/session/pause.public';
import { isEditorOpen, pauseRenderedPage } from './session-pause';
import { PagePending } from '../routes/root/status/pending';
import { routeTree } from '../routes/root/route-tree';
import { loadCurrentUser } from '../routes/root/route-context';

export function createAppRouter(
  queryClient: QueryClient,
  apiClient: ApiClient,
  history?: RouterHistory,
) {
  let revalidate: () => void = () => undefined;
  const sessionPause = createSessionPause();
  const router = createRouter({
    routeTree,
    context: {
      queryClient,
      apiClient,
      sessionPause,
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
  // A rendered page pauses in place, keeping what was typed into it. The
  // editor observes identity and pauses with its draft. While a navigation
  // loads, its route guard's account-change fence signs out instead.
  let recovering = false;
  revalidate = () => {
    const editorIsOpen = isEditorOpen(router);
    if (
      !editorIsOpen &&
      pauseRenderedPage(
        { router, queryClient, apiClient, sessionPause },
        'expired',
      )
    )
      return;
    if (recovering) return;
    recovering = true;
    const previous = queryClient.getQueryData(
      currentUserQueryOptions(apiClient).queryKey,
    );
    const recovery = editorIsOpen
      ? queryClient.refetchQueries({
          queryKey: currentUserQueryKey,
          exact: true,
        })
      : loadCurrentUser({
          queryClient,
          apiClient,
          sessionPause,
          onSessionExpired: revalidate,
        }).then(
          async (current) => {
            if (current.id !== previous?.id) await router.invalidate();
          },
          async (error: unknown) => {
            if (isRedirect(error)) await router.invalidate();
          },
        );
    void recovery.finally(() => {
      recovering = false;
    });
  };
  // Every answer that ends the session, from a read or any command, reaches
  // this one owner through the API client. A navigation still loading leaves
  // it to its route guard, and with nobody signed in (a refused sign-in)
  // there is no page to keep.
  apiClient.onSessionExpired(() => {
    if (router.state.status !== 'idle') return;
    if (queryClient.getQueryData(currentUserQueryKey) === undefined) return;
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
