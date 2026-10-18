import { useEffect, useRef } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link, useRouterState } from '@tanstack/react-router';
import { settingsGroups } from './settings-destinations';

/**
 * Settings' own navigation. On wide screens each page is a bead on one
 * thread and the open page is the knot; narrower screens get a row that
 * scrolls sideways above the page.
 */
export function SettingsRail({
  workspace,
}: Readonly<{ workspace: AccessibleWorkspace }>) {
  const groups = settingsGroups(workspace);
  const navigation = useRef<HTMLElement>(null);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // On a phone the open page can sit past the edge of the row: centre it.
  useEffect(() => {
    const row = navigation.current;
    const current = row?.querySelector('[aria-current="page"]');
    if (row == null || current == null || row.scrollWidth <= row.clientWidth)
      return;
    const rowBox = row.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    row.scrollLeft += box.left - rowBox.left - (rowBox.width - box.width) / 2;
  }, [pathname]);
  return (
    <nav
      ref={navigation}
      aria-label="Settings"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 md:-mx-8 md:px-8 xl:sticky xl:top-6 xl:mx-0 xl:flex-col xl:gap-7 xl:self-start xl:overflow-visible xl:px-0 xl:pt-3 xl:pb-0"
    >
      {groups.map((group) => (
        <div key={group.label} className="flex shrink-0 xl:flex-col xl:gap-2">
          {/* The list carries the group's name; this only shows it. */}
          <p
            aria-hidden="true"
            className="hidden text-xs text-subtle-foreground xl:block xl:pl-8"
          >
            {group.label}
          </p>
          <ul
            aria-label={group.label}
            className="relative flex gap-2 xl:flex-col xl:gap-0 xl:before:absolute xl:before:top-4 xl:before:bottom-4 xl:before:left-[0.6875rem] xl:before:w-px xl:before:bg-border"
          >
            {group.destinations.map((destination) => (
              <li key={destination.to} className="shrink-0">
                <Link
                  to={destination.to}
                  params={{ workspaceId: workspace.id }}
                  activeOptions={{ exact: destination.exact ?? false }}
                  className="group flex items-center gap-3 rounded-full border border-border px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-ring aria-[current=page]:border-action/35 aria-[current=page]:bg-action/10 aria-[current=page]:text-accent-foreground xl:rounded-md xl:border-0 xl:py-1.5 xl:pr-2 xl:pl-0 xl:aria-[current=page]:bg-transparent xl:aria-[current=page]:text-foreground"
                >
                  <span
                    aria-hidden="true"
                    className="relative z-1 hidden size-5.5 shrink-0 place-items-center xl:grid"
                  >
                    <span className="size-2 rounded-full border border-border-strong bg-background transition-[scale,background-color,border-color,box-shadow] duration-200 ease-unspool group-hover:border-foreground/50 group-aria-[current=page]:scale-125 group-aria-[current=page]:border-action group-aria-[current=page]:bg-action group-aria-[current=page]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--action)_22%,transparent)] motion-reduce:transition-none" />
                  </span>
                  {destination.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
