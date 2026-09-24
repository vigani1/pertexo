import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { WorkflowIcon } from 'lucide-react';
import { WorkspaceAccountCard } from './workspace-account-card';
import { WorkspaceNavigation } from './workspace-navigation';

export function WorkspaceSidebarContent({
  user,
  workspace,
  logoutPending,
  logoutError,
  onChangeWorkspace,
  onLogout,
}: Readonly<{
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  logoutPending: boolean;
  logoutError?: string;
  onChangeWorkspace: () => void;
  onLogout: () => void;
}>) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <Link
        to="/w/$workspaceId/workflows"
        params={{ workspaceId: workspace.id }}
        className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-2.5 hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="relative grid size-9 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary shadow-glow-primary">
          <span className="font-heading text-lg font-bold" translate="no">
            P
          </span>
          <WorkflowIcon
            aria-hidden="true"
            className="absolute -right-1 -bottom-1 size-4 rounded-sm bg-background p-0.5 text-secondary"
          />
        </span>
        <span className="min-w-0">
          <span
            translate="no"
            className="block truncate font-heading text-xl font-semibold tracking-tight text-primary"
          >
            Pertexo<span className="text-secondary">.</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {workspace.name}
          </span>
        </span>
      </Link>

      <WorkspaceNavigation
        workspaceId={workspace.id}
        canReadOverview={
          workspace.capabilities.includes('workflow:read') ||
          workspace.capabilities.includes('run:read')
        }
        canReadRuns={workspace.capabilities.includes('run:read')}
        canReadConnections={workspace.capabilities.includes('connection:read')}
        canReadMembers={workspace.capabilities.includes('member:read')}
        canManageWorkspace={workspace.capabilities.includes('workspace:manage')}
        canReadNotifications={workspace.capabilities.includes(
          'workflow:update',
        )}
      />

      <WorkspaceAccountCard
        user={user}
        workspace={workspace}
        logoutPending={logoutPending}
        {...(logoutError === undefined ? {} : { logoutError })}
        onChangeWorkspace={onChangeWorkspace}
        onLogout={onLogout}
      />
    </div>
  );
}
