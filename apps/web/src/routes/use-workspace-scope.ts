import { useRouteContext } from '@tanstack/react-router';

/** The API client, person and workspace resolved by the workspace scope. */
export function useWorkspaceScope() {
  const { apiClient, user, workspace } = useRouteContext({
    from: '/w/$workspaceId',
  });
  return { apiClient, user, workspace };
}
