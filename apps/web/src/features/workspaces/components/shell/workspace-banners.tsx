import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { StatusGlyph, type StatusTone } from '@/components/ui/status';
import { buttonVariants } from '@/components/ui/button-variants';
import { useOnlineStatus } from '@/lib/use-online-status';
import { cn } from '@/lib/utils';

function Banner({
  tone,
  children,
  action,
}: Readonly<{ tone: StatusTone; children: ReactNode; action?: ReactNode }>) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm',
        tone === 'failure'
          ? 'border-destructive/25 bg-destructive/6 text-destructive'
          : 'border-warning/25 bg-warning/6 text-warning',
      )}
    >
      <StatusGlyph tone={tone} />
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
      {action}
    </div>
  );
}

/** States that last: shown under the breadcrumb on every page. */
export function WorkspaceBanners({
  workspace,
}: Readonly<{ workspace: AccessibleWorkspace }>) {
  const online = useOnlineStatus();
  const canManage = workspace.capabilities.includes('workspace:manage');
  const banners: ReactNode[] = [];
  if (!online)
    banners.push(
      <Banner key="offline" tone="attention">
        You’re offline. Changes wait here and live updates resume when you
        reconnect.
      </Banner>,
    );
  if (workspace.status === 'pending_deletion')
    banners.push(
      <Banner
        key="deletion"
        tone="failure"
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
      </Banner>,
    );
  if (workspace.status === 'suspended')
    banners.push(
      <Banner key="suspended" tone="attention">
        This workspace is suspended. You can look around, but runs and changes
        are paused.
      </Banner>,
    );
  if (banners.length === 0) return null;
  return <div className="flex flex-col gap-2">{banners}</div>;
}
