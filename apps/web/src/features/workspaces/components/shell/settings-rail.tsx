import { useState } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { ChevronsUpDownIcon } from 'lucide-react';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  settingsGroups,
  type SettingsDestination,
  type SettingsGroup,
} from './settings-destinations';

/**
 * Settings' own navigation. Beside the page, each section is a bead on one
 * thread and the open one is the knot. When the page is too narrow for both
 * (a container query, not the window) one button names the open section and
 * lists every section in a sheet.
 */
export function SettingsRail({
  workspace,
}: Readonly<{ workspace: AccessibleWorkspace }>) {
  const groups = settingsGroups(workspace);
  return (
    <nav
      aria-label="Settings"
      className="@3xl:sticky @3xl:top-6 @3xl:self-start"
    >
      <div className="hidden @3xl:flex @3xl:flex-col @3xl:gap-7 @3xl:pt-3">
        {groups.map((group) => (
          <RailGroup key={group.label} group={group} workspace={workspace} />
        ))}
      </div>
      <SectionSwitcher groups={groups} workspace={workspace} />
    </nav>
  );
}

function RailGroup({
  group,
  workspace,
}: Readonly<{ group: SettingsGroup; workspace: AccessibleWorkspace }>) {
  return (
    <div className="flex flex-col gap-2">
      {/* The list carries the group's name; this only shows it. */}
      <p aria-hidden="true" className="pl-8 text-xs text-subtle-foreground">
        {group.label}
      </p>
      <ul
        aria-label={group.label}
        className="relative flex flex-col before:absolute before:top-4 before:bottom-4 before:left-[0.6875rem] before:w-px before:bg-border"
      >
        {group.destinations.map((destination) => (
          <li key={destination.to}>
            <Link
              to={destination.to}
              params={{ workspaceId: workspace.id }}
              activeOptions={{ exact: destination.exact ?? false }}
              className="group flex items-center gap-3 rounded-md py-1.5 pr-2 text-sm whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-ring aria-[current=page]:text-foreground"
            >
              <span
                aria-hidden="true"
                className="relative z-1 grid size-5.5 shrink-0 place-items-center"
              >
                <span className="size-2 rounded-full border border-border-strong bg-background transition-[scale,background-color,border-color,box-shadow] duration-200 ease-unspool group-hover:border-foreground/50 group-aria-[current=page]:scale-125 group-aria-[current=page]:border-action group-aria-[current=page]:bg-action group-aria-[current=page]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--action)_22%,transparent)] motion-reduce:transition-none" />
              </span>
              {destination.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Below the rail's breakpoint: "Settings · Usage" as one button, and every
 * section grouped in a sheet, so the page never starts with a row of pills
 * running off the edge.
 */
function SectionSwitcher({
  groups,
  workspace,
}: Readonly<{
  groups: readonly SettingsGroup[];
  workspace: AccessibleWorkspace;
}>) {
  const [open, setOpen] = useState(false);
  const matchRoute = useMatchRoute();
  const isOpen = (destination: SettingsDestination) =>
    Boolean(
      matchRoute({
        to: destination.to,
        params: { workspaceId: workspace.id },
        fuzzy: !(destination.exact ?? false),
      }),
    );
  const current = groups
    .flatMap((group) => group.destinations)
    .find((destination) => isOpen(destination));
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface-ink/[0.025] px-3.5 py-2.5 text-left text-sm outline-none transition-colors hover:bg-surface-ink/[0.05] focus-ring @3xl:hidden"
        aria-label={`Settings section: ${current?.label ?? 'General'}. Choose another`}
      >
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-action shadow-[0_0_0_3px_color-mix(in_srgb,var(--action)_22%,transparent)]"
        />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-subtle-foreground">Settings · </span>
          <span className="font-medium text-foreground">
            {current?.label ?? 'General'}
          </span>
        </span>
        <ChevronsUpDownIcon
          aria-hidden="true"
          className="size-4 text-subtle-foreground"
        />
      </SheetTrigger>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <p
                aria-hidden="true"
                className="mb-1.5 px-2 text-xs text-subtle-foreground"
              >
                {group.label}
              </p>
              <ul className="flex flex-col">
                {group.destinations.map((destination) => (
                  <li key={destination.to}>
                    <Link
                      to={destination.to}
                      params={{ workspaceId: workspace.id }}
                      activeOptions={{ exact: destination.exact ?? false }}
                      onClick={() => {
                        setOpen(false);
                      }}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-2 py-2.5 text-sm text-muted-foreground outline-none hover:bg-surface-ink/5 hover:text-foreground focus-ring',
                        'aria-[current=page]:bg-action/8 aria-[current=page]:text-accent-foreground',
                      )}
                    >
                      {destination.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
