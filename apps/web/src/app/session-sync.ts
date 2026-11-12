import {
  subscribeSessionChanges,
  notifySessionObservers,
} from '@/features/auth/session/sync.public';
import { workflowBuildRoute } from '@/routes/workflow/hub/routes';
import { isSessionExpired } from '@/lib/api/error';
import type { QueryClient } from '@tanstack/react-query';
import type { createAppRouter } from './router';

/** One app lifetime owns session invalidation; local payload owners only dispose their data. */
export function synchronizeApplicationSession(
  queryClient: QueryClient,
  router: ReturnType<typeof createAppRouter>,
) {
  let refreshing = false;
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    const editorIsOpen = router.state.matches.some(
      (match) => match.routeId === workflowBuildRoute.id,
    );
    // clear destroys queries synchronously and fences cancellation-ignoring reads.
    queryClient.clear();
    // The editor pauses and retains its recoverable unsaved draft.
    void (editorIsOpen ? Promise.resolve() : router.invalidate()).finally(
      () => {
        refreshing = false;
      },
    );
  };
  const stopSession = subscribeSessionChanges(refresh);
  const stopMutations = queryClient.getMutationCache().subscribe((event) => {
    if (
      event.type !== 'updated' ||
      event.action.type !== 'error' ||
      !isSessionExpired(event.action.error)
    )
      return;
    notifySessionObservers();
    refresh();
  });
  return () => {
    stopSession();
    stopMutations();
  };
}
