import type { AnyRouter } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { currentUserQueryOptions } from '@/features/auth/session/auth-session-queries.public';
import type {
  SessionPause,
  SessionPauseReason,
} from '@/features/auth/session/pause.public';
import type { ApiClient } from '@/lib/api/client';
import { workflowBuildRoute } from '@/routes/workflow/hub/routes';

/** The editor owns its own pause, fenced into its save pipeline. */
export function isEditorOpen(router: AnyRouter): boolean {
  return router.state.matches.some(
    (match) => match.routeId === workflowBuildRoute.id,
  );
}

/**
 * Pauses the page on screen for the account it belongs to. Returns false
 * when there is nothing to keep: no one was signed in, or a navigation is
 * still loading, whose route guard signs out instead.
 */
export function pauseRenderedPage(
  dependencies: Readonly<{
    router: AnyRouter;
    queryClient: QueryClient;
    apiClient: ApiClient;
    sessionPause: SessionPause;
  }>,
  reason: SessionPauseReason,
): boolean {
  const { router, queryClient, apiClient, sessionPause } = dependencies;
  if (router.state.status !== 'idle') return false;
  const user = queryClient.getQueryData(
    currentUserQueryOptions(apiClient).queryKey,
  );
  if (user === undefined) return false;
  sessionPause.pause(user.id, reason);
  return true;
}
