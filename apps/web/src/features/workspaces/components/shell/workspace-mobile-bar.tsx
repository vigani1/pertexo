import { useState, type ReactNode, type Ref } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link, useMatchRoute } from '@tanstack/react-router';
import {
  InboxIcon,
  MoreHorizontalIcon,
  WavesIcon,
  WorkflowIcon,
} from 'lucide-react';
import { CORE_IDLE_ENERGY, CoreOrb } from '@/components/patterns/core/orb';
import { cn } from '@/lib/utils';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { spineDestinations, useIncludedPage } from './spine-destinations';

const AWAY_WHILE_TYPING =
  'transition-[visibility] delay-300 typing:invisible typing:delay-0 typing:duration-0';

const barLinkClass =
  "flex min-w-0 flex-1 flex-col items-center gap-1 py-1.5 text-[0.68rem] text-subtle-foreground outline-none aria-[current=page]:text-accent-foreground data-[active=true]:text-accent-foreground focus-visible:text-foreground [&_svg:not([class*='size-'])]:size-5";

/** Bottom navigation for phones: Home, Workflows, Runs, Inbox and More. */
type WorkspaceMobileBarProps = Readonly<{
  workspace: AccessibleWorkspace;
  liveRunCount: number | undefined;
  unreadNoticeCount: number | undefined;
  /** The Inbox destination, which new-failure notices hang from. */
  inboxRef?: Ref<HTMLAnchorElement> | undefined;
  more: ReactNode;
}>;

export function WorkspaceMobileBar(props: WorkspaceMobileBarProps) {
  const {
    workspace,
    canReadRuns,
    canReadInbox,
    inboxRef,
    inboxIncluded,
    unread,
    moreOpen,
    setMoreOpen,
    moreActive,
    secondary,
    more,
  } = useMobileDestinations(props);
  return (
    <>
      {/* Content fades out under the floating bar instead of showing
          through the gap below it. While typing both step aside, and come
          back 300 ms after: the tap that ends typing (Approve under the
          keyboard) then lands on its button, not on the returning bar. */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none fixed inset-x-0 bottom-0 z-20 h-24 bg-linear-to-t from-background via-background/85 to-transparent md:hidden',
          AWAY_WHILE_TYPING,
        )}
      />
      <nav
        aria-label="Workspace"
        className={cn(
          'lens fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex items-center rounded-2xl px-2 py-1 md:hidden',
          AWAY_WHILE_TYPING,
        )}
      >
        <Link
          to="/w/$workspaceId"
          params={{ workspaceId: workspace.id }}
          activeOptions={{ exact: true }}
          className={barLinkClass}
        >
          {/* The same 20px box as the icons beside it, so labels line up. */}
          <span className="grid size-5 place-items-center">
            <CoreOrb
              state="idle"
              energy={CORE_IDLE_ENERGY}
              className="size-6"
            />
          </span>
          Home
        </Link>
        <Link
          to="/w/$workspaceId/workflows"
          params={{ workspaceId: workspace.id }}
          className={barLinkClass}
        >
          <WorkflowIcon aria-hidden="true" />
          Workflows
        </Link>
        {canReadRuns ? (
          <Link
            to="/w/$workspaceId/runs"
            params={{ workspaceId: workspace.id }}
            className={barLinkClass}
          >
            <WavesIcon aria-hidden="true" />
            Runs
          </Link>
        ) : null}
        {canReadInbox ? (
          <Link
            ref={inboxRef}
            to="/w/$workspaceId/inbox"
            params={{ workspaceId: workspace.id }}
            inactiveProps={inboxIncluded ? { 'aria-current': 'page' } : {}}
            aria-label={
              unread === 0 ? 'Inbox' : `Inbox, ${String(unread)} unread`
            }
            className={barLinkClass}
          >
            <span className="relative">
              <InboxIcon aria-hidden="true" />
              {unread === 0 ? null : (
                <span
                  aria-hidden="true"
                  className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-action"
                />
              )}
            </span>
            Inbox
          </Link>
        ) : null}
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetTrigger className={barLinkClass} data-active={moreActive}>
            <MoreHorizontalIcon aria-hidden="true" />
            More
          </SheetTrigger>
          <SheetContent side="bottom">
            <SheetHeader>
              <SheetTitle>More</SheetTitle>
            </SheetHeader>
            {/* Following any link closes More, including the account links
                the shell passes in, which stay inside this workspace. */}
            <SheetBody
              className="flex flex-col gap-1"
              onClick={(event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest('a') !== null
                )
                  setMoreOpen(false);
              }}
            >
              {secondary.map((destination) => (
                <Link
                  key={destination.to}
                  to={destination.to}
                  params={{ workspaceId: workspace.id }}
                  activeOptions={{ exact: destination.exact ?? false }}
                  className="flex items-center gap-3 rounded-md px-2 py-2.5 text-sm text-muted-foreground hover:bg-surface-ink/5 hover:text-foreground aria-[current=page]:text-accent-foreground [&_svg]:size-4"
                >
                  {destination.icon}
                  {destination.label}
                </Link>
              ))}
              <div className="mt-3 border-t border-border pt-3">{more}</div>
            </SheetBody>
          </SheetContent>
        </Sheet>
      </nav>
    </>
  );
}

function useMobileDestinations({
  workspace,
  liveRunCount,
  unreadNoticeCount,
  inboxRef,
  more,
}: WorkspaceMobileBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const destinations = spineDestinations(
    workspace,
    liveRunCount,
    unreadNoticeCount,
  );
  const secondary = [
    ...destinations.primary.filter(
      (destination) =>
        destination.to !== '/w/$workspaceId/workflows' &&
        destination.to !== '/w/$workspaceId/runs' &&
        destination.to !== '/w/$workspaceId/inbox',
    ),
    ...destinations.workspace,
  ];
  const inbox = destinations.primary.find(
    (destination) => destination.to === '/w/$workspaceId/inbox',
  );
  const inboxIncluded = useIncludedPage(
    workspace.id,
    inbox ?? { to: '/w/$workspaceId/inbox', label: 'Inbox', icon: null },
  );
  const canReadRuns = workspace.capabilities.includes('run:read');
  const canReadInbox = workspace.capabilities.includes('workspace:read');
  const unread = unreadNoticeCount ?? 0;
  // Pages that live under More light More, so a page always shows where it is.
  const matchRoute = useMatchRoute();
  const moreActive = secondary.some((destination) =>
    Boolean(
      matchRoute({
        to: destination.to,
        params: { workspaceId: workspace.id },
        fuzzy: true,
      }),
    ),
  );

  return {
    workspace,
    canReadRuns,
    canReadInbox,
    inboxRef,
    inboxIncluded,
    unread,
    moreOpen,
    setMoreOpen,
    moreActive,
    secondary,
    more,
  } as const;
}
