import { useState, type ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { MoreHorizontalIcon, WavesIcon, WorkflowIcon } from 'lucide-react';
import { CoreOrb } from '@/components/patterns/core-orb';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { spineDestinations } from './spine-destinations';

const barLinkClass =
  "flex min-w-0 flex-1 flex-col items-center gap-1 py-1.5 text-[0.68rem] text-subtle-foreground outline-none aria-[current=page]:text-accent-foreground focus-visible:text-foreground [&_svg:not([class*='size-'])]:size-5";

/** Bottom navigation for phones: Home, Workflows, Runs and More. */
export function WorkspaceMobileBar({
  workspace,
  liveRunCount,
  more,
}: Readonly<{
  workspace: AccessibleWorkspace;
  liveRunCount: number | undefined;
  more: ReactNode;
}>) {
  const [moreOpen, setMoreOpen] = useState(false);
  const destinations = spineDestinations(workspace, liveRunCount);
  const secondary = [
    ...destinations.primary.filter(
      (destination) =>
        destination.to !== '/w/$workspaceId/workflows' &&
        destination.to !== '/w/$workspaceId/runs',
    ),
    ...destinations.workspace,
  ];
  const canReadRuns = workspace.capabilities.includes('run:read');
  return (
    <nav
      aria-label="Workspace"
      className="lens fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex items-center rounded-2xl px-2 py-1 md:hidden"
    >
      <Link
        to="/w/$workspaceId"
        params={{ workspaceId: workspace.id }}
        activeOptions={{ exact: true }}
        className={barLinkClass}
      >
        <CoreOrb state="live" className="size-6" />
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
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetTrigger className={barLinkClass}>
          <MoreHorizontalIcon aria-hidden="true" />
          More
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-1">
            {secondary.map((destination) => (
              <Link
                key={destination.to}
                to={destination.to}
                params={{ workspaceId: workspace.id }}
                onClick={() => {
                  setMoreOpen(false);
                }}
                className="flex items-center gap-3 rounded-md px-2 py-2.5 text-sm text-muted-foreground hover:bg-white/5 hover:text-foreground aria-[current=page]:text-accent-foreground [&_svg]:size-4"
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
  );
}
