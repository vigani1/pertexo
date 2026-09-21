import { Link } from '@tanstack/react-router';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { cn } from '@/lib/utils';

const itemClass =
  'rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export function WorkspaceSettingsNavigation({
  workspace,
}: Readonly<{ workspace: AccessibleWorkspace }>) {
  const canReadMembers = workspace.capabilities.includes('member:read');
  const canReadNotifications =
    workspace.capabilities.includes('workflow:update');

  return (
    <nav
      aria-label="Workspace settings"
      className="mb-8 flex gap-1 overflow-x-auto border-b border-border pb-3"
    >
      <Link
        to="/w/$workspaceId/settings/general"
        params={{ workspaceId: workspace.id }}
        className={itemClass}
        activeProps={{
          'aria-current': 'page',
          className: cn(itemClass, 'bg-primary/10 text-primary'),
        }}
      >
        General
      </Link>
      {canReadMembers ? (
        <Link
          to="/w/$workspaceId/settings/members"
          params={{ workspaceId: workspace.id }}
          className={itemClass}
          activeProps={{
            'aria-current': 'page',
            className: cn(itemClass, 'bg-primary/10 text-primary'),
          }}
        >
          Members
        </Link>
      ) : null}
      {canReadNotifications ? (
        <Link
          to="/w/$workspaceId/settings/notifications"
          params={{ workspaceId: workspace.id }}
          className={itemClass}
          activeProps={{
            'aria-current': 'page',
            className: cn(itemClass, 'bg-primary/10 text-primary'),
          }}
        >
          Notifications
        </Link>
      ) : null}
    </nav>
  );
}
