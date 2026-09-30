import type { CSSProperties } from 'react';
import type { WorkspaceInboxThread } from '@pertexo/contracts/schemas/workspace-inbox';
import { Toast } from '@base-ui/react/toast';
import { Link } from '@tanstack/react-router';
import { XIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import { StatusGlyph } from '@/components/ui/status';
import { statusToneText } from '@/components/ui/status-tone';
import { formatElapsedTime } from '@/lib/format-time';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import {
  ARRIVAL_GAP_PX,
  ARRIVAL_SWIPE_DIRECTION,
  describeInboxArrival,
  type InboxArrivalData,
  type InboxArrivalSide,
} from '../model/inbox-arrival';
import { useArrivalSwipe } from './use-arrival-swipe';

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
} as const;

/**
 * The thread that leaves the Inbox icon and stops at a cross, where the
 * notice unfurls. It is Base UI's arrow, so it stays on the icon even when
 * the notice shifts to fit the screen.
 */
function Snag({
  side,
  className,
}: Readonly<{ side: InboxArrivalSide; className: string }>) {
  const gap = ARRIVAL_GAP_PX[side];
  return (
    <Toast.Arrow
      className={cn(
        'pointer-events-none',
        side === 'right' ? 'right-full h-4' : 'top-full w-4',
        className,
      )}
      style={side === 'right' ? { width: gap } : { height: gap }}
    >
      {side === 'right' ? (
        <svg
          viewBox={`0 0 ${String(gap)} 16`}
          className="size-full overflow-visible"
          {...strokeProps}
        >
          <path
            d={`M0 8H${String(gap - 14)}`}
            pathLength={1}
            className="arrival-thread"
          />
          <path
            d={`M${String(gap - 11)} 4l8 8M${String(gap - 3)} 4l-8 8`}
            className="arrival-cross"
          />
        </svg>
      ) : (
        <svg
          viewBox={`0 0 16 ${String(gap)}`}
          className="size-full overflow-visible"
          {...strokeProps}
        >
          <path
            d={`M8 ${String(gap)}V14`}
            pathLength={1}
            className="arrival-thread"
          />
          <path d="M4 3l8 8M12 3l-8 8" className="arrival-cross" />
        </svg>
      )}
    </Toast.Arrow>
  );
}

/**
 * The arrival notice: what failed, how often and where, with the way to the
 * run, or to the inbox when several workflows failed at once. Its timer is a
 * thread that pauses while the notice is hovered or focused. Swiping it
 * toward the Inbox dismisses it, like the close button; it stays unread.
 */
export function InboxArrivalCard({
  workspaceId,
  toast,
  onOpenRun,
  onOpenInbox,
}: Readonly<{
  workspaceId: string;
  toast: Toast.Root.ToastObject<InboxArrivalData>;
  onOpenRun: (thread: WorkspaceInboxThread) => void;
  onOpenInbox: () => void;
}>) {
  const nowMs = useNow(30_000);
  const { close } = Toast.useToastManager();
  const data = toast.data;
  const swipe = useArrivalSwipe(
    data?.side === undefined ? undefined : ARRIVAL_SWIPE_DIRECTION[data.side],
    () => {
      close(toast.id);
    },
  );
  if (data === undefined) return null;
  const view = describeInboxArrival(data.threads);
  const tone = statusToneText[view.tone];
  const timeout = toast.timeout ?? 0;
  return (
    <Toast.Root
      toast={toast}
      {...swipe}
      data-slot="inbox-arrival"
      className={cn(
        'group/arrival relative outline-none',
        data.side === 'right' && 'touch-pan-y',
        data.side === 'top' && 'touch-pan-x',
      )}
    >
      {data.side === undefined ? null : (
        <Snag side={data.side} className={tone} />
      )}
      <div
        data-side={data.side}
        className="arrival-card popup-lens relative w-[min(20rem,calc(100vw-2rem))] rounded-lg px-4 pt-3 pb-4 text-sm"
      >
        <div className="arrival-content">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'font-mono text-[0.68rem] tracking-wide uppercase',
                  tone,
                )}
              >
                {view.kicker}
                {view.thread === undefined ? null : (
                  <>
                    {' · '}
                    <time dateTime={view.thread.latestOccurredAt}>
                      {formatElapsedTime(view.thread.latestOccurredAt, nowMs)}
                    </time>
                  </>
                )}
              </p>
              <Toast.Title className="mt-1 truncate font-display text-lg leading-tight text-foreground [--display-optical-size:24] [--display-width:84%]">
                {view.title}
              </Toast.Title>
              <Toast.Description className="mt-1 text-[0.8rem] text-muted-foreground">
                {view.detail}
              </Toast.Description>
            </div>
            <Toast.Close
              aria-label="Dismiss notification"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
                '-mt-1 -mr-2',
              )}
            >
              <XIcon aria-hidden="true" />
            </Toast.Close>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span aria-hidden="true" className="flex items-center">
              {view.marks.map((mark, index) => (
                <StatusGlyph
                  // A fixed row whose order never changes.
                  key={index}
                  tone={mark}
                  className={cn('size-3.5', statusToneText[mark])}
                />
              ))}
              {view.more === 0 ? null : (
                <span className={cn('ml-1.5 font-mono text-[0.68rem]', tone)}>
                  +{view.more}
                </span>
              )}
            </span>
            {view.thread === undefined ? (
              <Link
                to="/w/$workspaceId/inbox"
                params={{ workspaceId }}
                search={{ filter: 'unread' }}
                className={buttonVariants({ size: 'sm' })}
                onClick={onOpenInbox}
              >
                Open inbox
              </Link>
            ) : (
              <Link
                to="/w/$workspaceId/runs/$runId"
                params={{ workspaceId, runId: view.thread.latestRunId }}
                className={buttonVariants({ size: 'sm' })}
                onClick={() => {
                  if (view.thread !== undefined) onOpenRun(view.thread);
                }}
              >
                Open run
              </Link>
            )}
          </div>
        </div>
        {timeout > 0 ? (
          <span
            key={data.sequence}
            aria-hidden="true"
            style={
              { '--toast-timeout': `${String(timeout)}ms` } as CSSProperties
            }
            className={cn(
              'absolute bottom-1.5 left-4 h-0.5 w-[calc(100%-2rem)] rounded-full bg-current opacity-70',
              'animate-[thread-timer_var(--toast-timeout)_linear_forwards] group-data-expanded/arrival:[animation-play-state:paused] motion-reduce:animate-none',
              tone,
            )}
          />
        ) : null}
      </div>
    </Toast.Root>
  );
}
