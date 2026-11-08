import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet } from '@tanstack/react-router';
import { WorkspaceDeletionPage } from '@/features/workspaces/deletion.public';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/workspaces-queries.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function WorkspaceScopeRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const discovery = useQuery(
    accessibleWorkspacesQueryOptions(apiClient, user.id),
  );
  const purging =
    workspace.status === 'purging' ||
    discovery.data?.some(
      (item) => item.id === workspace.id && item.status === 'purging',
    ) === true;
  const [observed, setObserved] = useState<string>();
  const identity = `${user.id}:${workspace.id}`;
  if (purging && observed !== identity) setObserved(identity);
  return purging || observed === identity ? (
    <WorkspaceDeletionPage
      key={identity}
      apiClient={apiClient}
      userId={user.id}
      workspaceId={workspace.id}
    />
  ) : (
    <Outlet />
  );
}
