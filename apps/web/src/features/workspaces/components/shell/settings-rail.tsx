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
import {
  settingsGroups,
  type SettingsDestination,
  type SettingsGroup,
} from './settings-destinations';

/**
 * Settings' own navigation. Beside the page, sections are grouped by purpose and the open one carries a knot. When the page is too narrow for both
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
      <p
        aria-hidden="true"
        className="pl-4 font-mono text-micro tracking-wider uppercase text-subtle-foreground"
      >
        {group.label}
      </p>
      <ul aria-label={group.label} className="flex flex-col gap-0.5">
        {group.destinations.map((destination) => (
          <li key={destination.to}>
            <Link
              to={destination.to}
              params={{ workspaceId: workspace.id }}
              activeOptions={{ exact: destination.exact ?? false }}
              className="group flex min-h-7.5 items-center gap-2 rounded-sm px-1 text-label whitespace-nowrap text-subtle-foreground outline-none transition-colors hover:text-foreground focus-ring aria-[current=page]:font-medium aria-[current=page]:text-foreground pointer-coarse:min-h-10"
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full group-aria-[current=page]:bg-action"
              />
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
        render={
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-3 rounded-sm px-1 py-2.5 text-left text-sm outline-none transition-colors hover:bg-select focus-ring @3xl:hidden"
          />
        }
      >
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-action"
        />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-subtle-foreground">Settings · </span>
          <span className="font-medium text-foreground">
            {current?.label ?? 'General'}
          </span>
          {/* The name starts with what it shows, so voice control finds
              it by the words on screen (WCAG 2.5.3). */}
          <span className="sr-only">, choose another section</span>
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
                      className="group flex min-h-10 items-center gap-2 rounded-sm px-1 text-label text-subtle-foreground outline-none hover:text-foreground focus-ring aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full group-aria-[current=page]:bg-action"
                      />
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
