import { useEffect, useEffectEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useMatches } from '@tanstack/react-router';
import { useNotifications } from '@/components/ui/use-notifications';
import { liveRunCountQueryOptions } from '@/features/workflow-runs/queries.public';
import { rememberLastWorkspace } from '@/features/workspaces/last-workspace.public';
import { WorkspaceShell } from '@/features/workspaces/public';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';
import { useLogout } from './use-logout';
import { useWorkspaceScope } from './use-workspace-scope';
import { WorkspaceCommandPalette } from './workspace-command-palette';

function useCommandShortcut(onOpen: () => void) {
  const open = useEffectEvent(onOpen);
  useEffect(() => {
    function listen(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() === 'k' &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        open();
      }
    }
    window.addEventListener('keydown', listen);
    return () => {
      window.removeEventListener('keydown', listen);
    };
  }, []);
}

export function WorkspaceShellRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const notifications = useNotifications();
  const logout = useLogout(apiClient, {
    onError: (message) => {
      notifications.error({
        title: 'Sign-out didn’t finish',
        description: message,
      });
    },
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const canReadRuns = workspace.capabilities.includes('run:read');
  const workspaces = useQuery(
    accessibleWorkspacesQueryOptions(apiClient, user.id),
  );
  const liveRunCount = useQuery({
    ...liveRunCountQueryOptions(apiClient, user.id, workspace.id),
    enabled: canReadRuns,
  });
  const crumbs = useMatches({
    select: (matches) =>
      matches.flatMap((match) =>
        match.staticData.crumb === undefined ? [] : [match.staticData.crumb],
      ),
  });

  useCommandShortcut(() => {
    setSearchOpen(true);
  });

  useEffect(() => {
    rememberLastWorkspace(user.id, workspace.id);
  }, [user.id, workspace.id]);

  return (
    <WorkspaceShell
      user={user}
      workspace={workspace}
      workspaces={workspaces.data ?? [workspace]}
      liveRunCount={canReadRuns ? liveRunCount.data : undefined}
      crumbs={crumbs.filter((crumb) => crumb !== 'Home')}
      logoutPending={logout.pending}
      onLogout={logout.requestLogout}
      onOpenSearch={() => {
        setSearchOpen(true);
      }}
    >
      <Outlet />
      <WorkspaceCommandPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        workspaces={workspaces.data ?? [workspace]}
        onLogout={logout.requestLogout}
      />
    </WorkspaceShell>
  );
}
