import { Link, useRouterState } from '@tanstack/react-router';
import {
  HistoryIcon,
  LayoutDashboardIcon,
  PlugZapIcon,
  SettingsIcon,
  WorkflowIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const navigationItemClass =
  'group relative flex min-h-10 min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-[color,background-color,transform] hover:bg-white/5 hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none';

export function WorkspaceNavigation({
  workspaceId,
  canReadOverview,
  canReadConnections,
  canReadMembers,
  canReadRuns,
  canManageWorkspace,
  canReadNotifications,
}: Readonly<{
  workspaceId: string;
  canReadOverview: boolean;
  canReadConnections: boolean;
  canReadMembers: boolean;
  canReadRuns: boolean;
  canManageWorkspace: boolean;
  canReadNotifications: boolean;
}>) {
  const settingsActive = useRouterState({
    select: (state) =>
      state.location.pathname.startsWith(`/w/${workspaceId}/settings/`),
  });
  return (
    <nav
      aria-label="Workspace navigation"
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto py-2"
    >
      {canReadOverview ? (
        <Link
          to="/w/$workspaceId/overview"
          params={{ workspaceId }}
          className={navigationItemClass}
          activeProps={{
            'aria-current': 'page',
            className: cn(
              navigationItemClass,
              'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_10%,transparent)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-primary before:shadow-glow-primary-strong',
            ),
          }}
        >
          <LayoutDashboardIcon aria-hidden="true" />
          <span className="truncate">Overview</span>
        </Link>
      ) : null}
      <Link
        to="/w/$workspaceId/workflows"
        params={{ workspaceId }}
        activeOptions={{ exact: false }}
        className={navigationItemClass}
        activeProps={{
          'aria-current': 'page',
          className: cn(
            navigationItemClass,
            'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_10%,transparent)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-primary before:shadow-glow-primary-strong',
          ),
        }}
      >
        <WorkflowIcon aria-hidden="true" />
        <span className="truncate">Workflows</span>
      </Link>
      {canReadConnections ? (
        <Link
          to="/w/$workspaceId/connections"
          params={{ workspaceId }}
          className={navigationItemClass}
          activeProps={{
            'aria-current': 'page',
            className: cn(
              navigationItemClass,
              'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_10%,transparent)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-primary before:shadow-glow-primary-strong',
            ),
          }}
        >
          <PlugZapIcon aria-hidden="true" />
          <span className="truncate">Connections</span>
        </Link>
      ) : null}
      {canReadRuns ? (
        <Link
          to="/w/$workspaceId/runs"
          params={{ workspaceId }}
          className={navigationItemClass}
          activeProps={{
            'aria-current': 'page',
            className: cn(
              navigationItemClass,
              'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_10%,transparent)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-primary before:shadow-glow-primary-strong',
            ),
          }}
        >
          <HistoryIcon aria-hidden="true" />
          <span className="truncate">Run history</span>
        </Link>
      ) : null}
      {canManageWorkspace || canReadMembers || canReadNotifications ? (
        <Link
          to={
            canManageWorkspace
              ? '/w/$workspaceId/settings/general'
              : canReadMembers
                ? '/w/$workspaceId/settings/members'
                : '/w/$workspaceId/settings/notifications'
          }
          params={{ workspaceId }}
          aria-current={settingsActive ? 'location' : undefined}
          className={cn(
            navigationItemClass,
            settingsActive &&
              'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_10%,transparent)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-primary before:shadow-glow-primary-strong',
          )}
        >
          <SettingsIcon aria-hidden="true" />
          <span className="truncate">Workspace settings</span>
        </Link>
      ) : null}
    </nav>
  );
}
