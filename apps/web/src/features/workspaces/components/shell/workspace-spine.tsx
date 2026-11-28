import { HelpMenu } from './help-menu';
import type { ReactNode, Ref } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { CORE_IDLE_ENERGY, CoreOrb } from '@/components/patterns/core/orb';
import { ThemeSwitchButton } from '@/components/patterns/appearance/theme-switch';
import { navigationTileClass } from '@/components/ui/button-variants';
import { Kbd } from '@/components/ui/kbd';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/class-names';
import {
  spineDestinations,
  useIncludedPage,
  type SpineDestination,
} from './spine-destinations';
import { shortcut } from '@/lib/shortcut-keys';

function formatBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function SpineLink({
  workspaceId,
  destination,
  anchorRef,
}: Readonly<{
  workspaceId: string;
  destination: SpineDestination;
  anchorRef?: Ref<HTMLAnchorElement> | undefined;
}>) {
  const label =
    destination.badge === undefined
      ? destination.label
      : `${destination.label}, ${String(destination.badge)} ${destination.badgeNoun ?? ''}`.trimEnd();
  const included = useIncludedPage(workspaceId, destination);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            ref={anchorRef}
            to={destination.to}
            params={{ workspaceId }}
            activeOptions={{ exact: destination.exact ?? false }}
            inactiveProps={included ? { 'aria-current': 'page' } : {}}
            aria-label={label}
            className={navigationTileClass}
          />
        }
      >
        {destination.icon}
        {destination.badge === undefined ? null : (
          // A tinted count inside the tile, not a loud pill hanging off it.
          // A new count rolls in, so a change is seen without a flash.
          <span
            key={destination.badge}
            className="absolute top-0.5 right-0.5 rounded-xs bg-action-soft px-0.5 font-mono text-micro leading-[0.8rem] font-semibold text-nav-on inset-ring inset-ring-action-line motion-safe:animate-[badge-roll_var(--duration-enter)_var(--ease-unspool)]"
          >
            {formatBadge(destination.badge)}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
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
            className="grid size-11 place-items-center rounded-lg core-home-paint outline-none focus-ring aria-[current=page]:inset-ring aria-[current=page]:inset-ring-live-line"
          />
        }
      >
        <CoreOrb
          state={liveRunCount ? 'live' : 'idle'}
          energy={
            liveRunCount
              ? 0.7 + Math.min(liveRunCount, 6) * 0.08
              : CORE_IDLE_ENERGY
          }
          className="size-10"
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
  unreadNoticeCount,
  inboxRef,
  onOpenSearch,
  account,
}: Readonly<{
  workspace: AccessibleWorkspace;
  liveRunCount: number | undefined;
  unreadNoticeCount: number | undefined;
  /** The Inbox destination, which new-failure notices hang from. */
  inboxRef?: Ref<HTMLAnchorElement> | undefined;
  onOpenSearch: () => void;
  account: ReactNode;
}>) {
  const destinations = spineDestinations(
    workspace,
    liveRunCount,
    unreadNoticeCount,
  );
  return (
    <nav
      aria-label="Workspace"
      className="lens fixed top-3 bottom-3 left-3 overflow-y-auto z-40 hidden w-15 flex-col items-center gap-1 rounded-3xl py-2.5 md:flex"
    >
      <HomeCore workspaceId={workspace.id} liveRunCount={liveRunCount} />
      <span aria-hidden="true" className="my-1.5 h-px w-6 shrink-0 bg-border" />
      {destinations.primary.map((destination) => (
        <SpineLink
          key={destination.to}
          workspaceId={workspace.id}
          destination={destination}
          anchorRef={
            destination.to === '/w/$workspaceId/inbox' ? inboxRef : undefined
          }
        />
      ))}
      <span aria-hidden="true" className="my-1.5 h-px w-6 shrink-0 bg-border" />
      {destinations.workspace.map((destination) => (
        <SpineLink
          key={destination.to}
          workspaceId={workspace.id}
          destination={destination}
        />
      ))}
      <span className="flex-1" />
      <HelpMenu className={navigationTileClass} />
      <ThemeSwitchButton />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Search"
              aria-keyshortcuts="Meta+K Control+K"
              className={cn(navigationTileClass)}
              onClick={onOpenSearch}
            />
          }
        >
          <SearchIcon />
        </TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          Search <Kbd>{shortcut('K')}</Kbd>
        </TooltipContent>
      </Tooltip>
      {account}
    </nav>
  );
}
