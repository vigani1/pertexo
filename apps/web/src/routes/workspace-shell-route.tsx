import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet } from '@tanstack/react-router';
import { useNotifications } from '@/components/ui/use-notifications';
import { liveRunCountQueryOptions } from '@/features/workflow-runs/queries.public';
import { rememberLastWorkspace } from '@/features/workspaces/last-workspace.public';
import { WorkspaceShell } from '@/features/workspaces/public';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';
import { useShellCrumbs, type Crumb } from './breadcrumbs';
import { CommandPaletteContext } from './command-palette-context';
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

/**
 * The spine, breadcrumb, banners and ⌘K around a workspace page. Pages under
 * the shell route get it from the layout; a page outside it (a missing
 * workflow) renders it around itself with its own `crumbs`.
 */
export function WorkspaceShellFrame({
  crumbs,
  children,
}: Readonly<{ crumbs?: readonly Crumb[]; children: ReactNode }>) {
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
  const routeCrumbs = useShellCrumbs(workspace);

  // Stable, so pages that receive it through context don't re-render.
  const openSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);
  useCommandShortcut(openSearch);

  useEffect(() => {
    rememberLastWorkspace(user.id, { id: workspace.id, name: workspace.name });
  }, [user.id, workspace.id, workspace.name]);

  return (
    <WorkspaceShell
      user={user}
      workspace={workspace}
      workspaces={workspaces.data ?? [workspace]}
      liveRunCount={canReadRuns ? liveRunCount.data : undefined}
      crumbs={crumbs ?? routeCrumbs}
      logoutPending={logout.pending}
      onLogout={logout.requestLogout}
      onOpenSearch={openSearch}
    >
      <CommandPaletteContext value={openSearch}>
        {children}
      </CommandPaletteContext>
      <WorkspaceCommandPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        workspaces={workspaces.data ?? [workspace]}
        onLogout={logout.requestLogout}
      />
    </WorkspaceShell>
  );
}

export function WorkspaceShellRoute() {
  return (
    <WorkspaceShellFrame>
      <Outlet />
    </WorkspaceShellFrame>
  );
}
