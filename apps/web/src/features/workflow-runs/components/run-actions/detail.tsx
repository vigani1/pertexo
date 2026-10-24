import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { OctagonXIcon, RotateCcwIcon } from 'lucide-react';
import { PageHeaderActions } from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';

/**
 * Replay and Cancel run. On phones they sit in a bar at thumb height above
 * the bottom navigation, with Open workflow beside them when there's room.
 */
export function RunDetailActions({
  compact,
  canReplay,
  canCancel,
  canOpenWorkflow,
  recoveryAction,
  onReplay,
  onCancel,
  scope,
}: Readonly<{
  compact: boolean;
  recoveryAction?: ReactNode;
  canReplay: boolean;
  canCancel: boolean;
  canOpenWorkflow: boolean;
  onReplay: () => void;
  onCancel: () => void;
  scope: Readonly<{ workspaceId: string; workflowId: string }>;
}>) {
  const { workspaceId, workflowId } = scope;

  // The actions share a phone's width: each takes its own width and the
  // rest is shared.
  const grow = compact ? 'flex-auto px-3' : undefined;
  // Replay, Cancel run and Open workflow don't all fit a phone's width. The
  // workflow's name at the top of the page links there too, so Open
  // workflow is the one that makes way.
  const roomToOpenWorkflow =
    !(canReplay && canCancel) && recoveryAction === undefined;
  const buttons = (
    <>
      {recoveryAction}
      {canReplay ? (
        <Button
          type="button"
          variant={compact ? 'default' : 'outline'}
          className={grow}
          onClick={onReplay}
        >
          <RotateCcwIcon aria-hidden="true" />
          Replay
        </Button>
      ) : null}
      {canCancel ? (
        <Button
          type="button"
          variant="destructive"
          className={grow}
          onClick={onCancel}
        >
          <OctagonXIcon aria-hidden="true" />
          {/* The same words at every size. */}
          Cancel run
        </Button>
      ) : null}
    </>
  );
  if (!compact)
    return (
      <PageHeaderActions className="md:self-start">{buttons}</PageHeaderActions>
    );
  return (
    <div
      role="group"
      aria-label="Run actions"
      className="lens fixed inset-x-3 bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.25rem)] z-30 flex gap-2 rounded-2xl p-2"
    >
      {buttons}
      {canOpenWorkflow && roomToOpenWorkflow ? (
        <Link
          to="/w/$workspaceId/workflows/$workflowId"
          params={{ workspaceId, workflowId }}
          className={buttonVariants({ variant: 'outline', className: grow })}
        >
          Open workflow
        </Link>
      ) : null}
    </div>
  );
}
