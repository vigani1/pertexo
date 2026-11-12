import { useQuery } from '@tanstack/react-query';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/workspaces-queries.public';
import { useRouteContext, useRouterState } from '@tanstack/react-router';
import { shownData } from '@/lib/api/error-copy';
import { workflowBuildRoute } from '../../workflow/hub/routes';

/** The API client, person and workspace resolved by the workspace scope. */
export function useWorkspaceScope() {
  const { apiClient, user, workspace } = useRouteContext({
    from: '/w/$workspaceId',
  });
  const editorIsOpen = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId === workflowBuildRoute.id),
  });
  // The editor owns its paused, recoverable draft. Ordinary pages follow the
  // latest workspace read rather than retaining old role/name/status props.
  const discovery = useQuery({
    ...accessibleWorkspacesQueryOptions(apiClient, user.id),
    enabled: !editorIsOpen,
  });
  const current = shownData(discovery)?.find(
    (item) => item.id === workspace.id,
  );
  return {
    apiClient,
    user,
    workspace: editorIsOpen ? workspace : (current ?? workspace),
  };
}
