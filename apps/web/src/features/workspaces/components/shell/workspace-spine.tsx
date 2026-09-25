import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { CoreOrb } from '@/components/patterns/core-orb';
import { Kbd } from '@/components/ui/kbd';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { spineDestinations, type SpineDestination } from './spine-destinations';

function formatBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}

const spineLinkClass =
  "relative grid size-10 place-items-center rounded-md text-subtle-foreground outline-none transition-colors hover:bg-white/5 hover:text-foreground focus-ring aria-[current=page]:bg-primary/10 aria-[current=page]:text-accent-foreground aria-[current=page]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_22%,transparent)] [&_svg:not([class*='size-'])]:size-[1.15rem]";

function SpineLink({
  workspaceId,
  destination,
}: Readonly<{ workspaceId: string; destination: SpineDestination }>) {
  const label =
    destination.badge === undefined
      ? destination.label
      : `${destination.label}, ${String(destination.badge)} running`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to={destination.to}
            params={{ workspaceId }}
            activeOptions={{ exact: destination.exact ?? false }}
            aria-label={label}
            className={spineLinkClass}
          />
        }
      >
        {destination.icon}
        {destination.badge === undefined ? null : (
          <span className="absolute -top-0.5 -right-1 rounded-sm bg-action px-1 font-mono text-[0.6rem] leading-[0.85rem] font-bold text-action-foreground">
            {formatBadge(destination.badge)}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">{destination.label}</TooltipContent>
    </Tooltip>
  );
}

function HomeCore({
  workspaceId,
  liveRunCount,
}: Readonly<{ workspaceId: string; liveRunCount: number | undefined }>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/w/$workspaceId"
            params={{ workspaceId }}
            activeOptions={{ exact: true }}
            aria-label="Home"
            className="grid size-11 place-items-center rounded-lg bg-[radial-gradient(circle,color-mix(in_srgb,var(--primary)_14%,transparent),transparent_70%)] outline-none focus-ring aria-[current=page]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
          />
        }
      >
        <CoreOrb
          state={liveRunCount === 0 ? 'idle' : 'live'}
          energy={0.7 + Math.min(liveRunCount ?? 0, 6) * 0.08}
          className="size-11"
        />
      </TooltipTrigger>
      <TooltipContent side="right">Home</TooltipContent>
    </Tooltip>
  );
}

/** The floating navigation spine (desktop). */
export function WorkspaceSpine({
  workspace,
  liveRunCount,
  onOpenSearch,
  account,
}: Readonly<{
  workspace: AccessibleWorkspace;
  liveRunCount: number | undefined;
  onOpenSearch: () => void;
  account: ReactNode;
}>) {
  const destinations = spineDestinations(workspace, liveRunCount);
  return (
    <nav
      aria-label="Workspace"
      className="lens fixed top-3 bottom-3 left-3 z-40 hidden w-15 flex-col items-center gap-1 rounded-xl py-2.5 md:flex"
    >
      <HomeCore workspaceId={workspace.id} liveRunCount={liveRunCount} />
      <span aria-hidden="true" className="my-1.5 h-px w-6 bg-white/9" />
      {destinations.primary.map((destination) => (
        <SpineLink
          key={destination.to}
          workspaceId={workspace.id}
          destination={destination}
        />
      ))}
      <span aria-hidden="true" className="my-1.5 h-px w-6 bg-white/9" />
      {destinations.workspace.map((destination) => (
        <SpineLink
          key={destination.to}
          workspaceId={workspace.id}
          destination={destination}
        />
      ))}
      <span className="flex-1" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Search"
              aria-keyshortcuts="Meta+K Control+K"
              className={cn(spineLinkClass)}
              onClick={onOpenSearch}
            />
          }
        >
          <SearchIcon />
        </TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          Search <Kbd>⌘K</Kbd>
        </TooltipContent>
      </Tooltip>
      {account}
    </nav>
  );
}
