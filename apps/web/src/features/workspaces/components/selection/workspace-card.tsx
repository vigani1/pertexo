import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { ArrowRightIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Status } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { WorkspaceMark } from '../shell/workspace-mark';
import { roleName, workspaceAvailability } from './workspace-availability';

/** One workspace: its mark, name, your role, its state and "last opened". */
export function WorkspaceCard({
  workspace,
  lastOpened,
  onSelect,
}: Readonly<{
  workspace: AccessibleWorkspace;
  lastOpened: boolean;
  onSelect: (workspace: AccessibleWorkspace) => void;
}>) {
  const availability = workspaceAvailability(workspace);
  return (
    <button
      type="button"
      disabled={!availability.openable}
      className={cn(
        'group/card flex h-full w-full min-w-0 flex-col gap-5 rounded-xl border border-border bg-card/60 p-5 text-left transition-[border-color,background-color,transform] duration-200 ease-unspool outline-none',
        'enabled:hover:-translate-y-px enabled:hover:border-primary/35 enabled:hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none motion-reduce:enabled:hover:translate-y-0',
        'disabled:cursor-not-allowed disabled:opacity-70',
      )}
      onClick={() => {
        onSelect(workspace);
      }}
    >
      <span className="flex w-full items-start justify-between gap-3">
        <WorkspaceMark
          name={workspace.name}
          className="size-11 rounded-lg text-sm"
        />
        {lastOpened ? <Badge variant="default">Last opened</Badge> : null}
      </span>
      <span className="flex min-w-0 flex-col gap-2">
        <span className="font-heading text-xl leading-tight font-semibold [overflow-wrap:anywhere]">
          {workspace.name}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="muted">{roleName(workspace.role)}</Badge>
          <Status tone={availability.tone}>{availability.status}</Status>
        </span>
      </span>
      <span className="mt-auto flex w-full items-center justify-between gap-3 text-[0.8rem] text-muted-foreground">
        <span>{availability.note}</span>
        {availability.openable ? (
          <span className="inline-flex items-center gap-1 font-semibold text-accent-foreground">
            {availability.action ?? 'Open'}
            <ArrowRightIcon
              aria-hidden="true"
              className="size-3.5 transition-transform group-hover/card:translate-x-0.5 motion-reduce:transition-none"
            />
          </span>
        ) : null}
      </span>
    </button>
  );
}
