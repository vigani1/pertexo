import {
  subscribeSessionChanges,
  notifySessionObservers,
} from '@/features/auth/session/sync.public';
import { isSessionExpired } from '@/lib/api/error';
import type { QueryClient } from '@tanstack/react-query';
import type { createAppRouter } from './router';
import { isEditorOpen, pauseRenderedPage } from './session-pause';

/** One app lifetime owns session invalidation; local payload owners only dispose their data. */
export function synchronizeApplicationSession(
  queryClient: QueryClient,
  router: ReturnType<typeof createAppRouter>,
) {
  const { apiClient, sessionPause, onSessionExpired } = router.options.context;
  let refreshing = false;
  // Another tab signed in or out. A rendered page waits, hidden, until it
  // knows who is signed in now; with nothing to keep, the routes recheck.
  const sessionChanged = () => {
    if (refreshing) return;
    const editorIsOpen = isEditorOpen(router);
    if (
      !editorIsOpen &&
      pauseRenderedPage(
        { router, queryClient, apiClient, sessionPause },
        'checking',
      )
    )
      return;
    refreshing = true;
    // clear destroys queries synchronously and fences cancellation-ignoring reads.
    queryClient.clear();
    // The editor pauses and retains its recoverable unsaved draft.
    void (editorIsOpen ? Promise.resolve() : router.invalidate()).finally(
      () => {
        refreshing = false;
      },
    );
  };
  const stopSession = subscribeSessionChanges(sessionChanged);
  const stopMutations = queryClient.getMutationCache().subscribe((event) => {
    if (
      event.type !== 'updated' ||
      event.action.type !== 'error' ||
      !isSessionExpired(event.action.error)
    )
      return;
    notifySessionObservers();
    if (isEditorOpen(router)) queryClient.clear();
    else onSessionExpired();
  });
  // Leaving the paused page (to sign in, or a command that ends the
  // session) ends its pause: the page it kept is gone.
  const stopNavigation = router.subscribe('onResolved', (event) => {
    if (event.pathChanged) sessionPause.resume();
  });
  return () => {
    stopSession();
    stopMutations();
    stopNavigation();
  };
}
