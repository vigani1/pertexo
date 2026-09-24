import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { Notice } from '@/components/ui/notice';
import { buttonVariants } from '@/components/ui/button-variants';
import { useOnlineStatus } from '@/lib/use-online-status';

/** States that last: shown under the breadcrumb on every page. */
export function WorkspaceBanners({
  workspace,
}: Readonly<{ workspace: AccessibleWorkspace }>) {
  const online = useOnlineStatus();
  const canManage = workspace.capabilities.includes('workspace:manage');
  const banners: ReactNode[] = [];
  if (!online)
    banners.push(
      <Notice key="offline" tone="warning">
        You’re offline. Changes wait here and live updates resume when you
        reconnect.
      </Notice>,
    );
  if (workspace.status === 'pending_deletion')
    banners.push(
      <Notice
        key="deletion"
        tone="destructive"
        role="status"
        action={
          canManage ? (
            <Link
              to="/w/$workspaceId/settings"
              params={{ workspaceId: workspace.id }}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              Restore
            </Link>
          ) : undefined
        }
      >
        This workspace is scheduled for deletion. Triggers are stopped and it
        can be restored for 30 days after the request.
      </Notice>,
    );
  if (workspace.status === 'suspended')
    banners.push(
      <Notice key="suspended" tone="warning">
        This workspace is suspended. You can look around, but runs and changes
        are paused.
      </Notice>,
    );
  if (banners.length === 0) return null;
  return <div className="flex flex-col gap-2">{banners}</div>;
}
