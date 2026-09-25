import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { CheckIcon, ChevronsUpDownIcon, LayoutGridIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WorkspaceMark } from './workspace-mark';

const STATUS_LABEL: Partial<Record<AccessibleWorkspace['status'], string>> = {
  suspended: 'Suspended',
  pending_deletion: 'Scheduled for deletion',
};

/** Breadcrumb root: the current workspace, switchable in place. */
export function WorkspaceSwitcher({
  workspace,
  workspaces,
}: Readonly<{
  workspace: AccessibleWorkspace;
  workspaces: readonly AccessibleWorkspace[];
}>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex max-w-60 items-center gap-2 rounded-md border border-white/6 bg-white/4 py-1 pr-2 pl-1 text-sm font-semibold text-foreground outline-none hover:bg-white/7 focus-ring">
        <WorkspaceMark name={workspace.name} />
        <span className="truncate">{workspace.name}</span>
        <ChevronsUpDownIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-subtle-foreground"
        />
        <span className="sr-only">Switch workspace</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {workspaces.map((candidate) => (
            <DropdownMenuLinkItem
              key={candidate.id}
              render={
                <Link
                  to="/w/$workspaceId"
                  params={{ workspaceId: candidate.id }}
                />
              }
            >
              <WorkspaceMark name={candidate.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">
                  {candidate.name}
                </span>
                <span className="block text-xs text-subtle-foreground capitalize">
                  {STATUS_LABEL[candidate.status] ?? candidate.role}
                </span>
              </span>
              {candidate.id === workspace.id ? (
                <CheckIcon aria-label="Current" className="text-primary" />
              ) : null}
            </DropdownMenuLinkItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem render={<Link to="/workspaces" />}>
          <LayoutGridIcon aria-hidden="true" />
          All workspaces
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
