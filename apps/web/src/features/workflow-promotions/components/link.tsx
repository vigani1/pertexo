import type { WorkflowPromotionSettings } from '@pertexo/contracts';
import { ArrowRightIcon } from 'lucide-react';
import { formatInitials } from '@/lib/format/initials';
import { cn } from '@/lib/utils';

/**
 * The promotion link as a picture: this workspace, a thread, and the one it
 * sends reviewed workflows to. Dashed while none is linked; amber when the
 * linked one can't be reached.
 */
export function PromotionLink({
  workspaceName,
  target,
}: Readonly<{
  workspaceName: string;
  target: WorkflowPromotionSettings['target'];
}>) {
  const linked = target?.status === 'available';
  return (
    <figure
      aria-label={
        target === null
          ? 'No workspace linked'
          : target.status === 'available'
            ? `Promotes to ${target.name}`
            : 'The linked workspace is unavailable'
      }
      className="flex flex-col gap-3 rounded-xl border border-white/7 bg-white/[0.02] p-5 sm:flex-row sm:items-center sm:gap-0"
    >
      <Workspace name={workspaceName} caption="This workspace" lit />
      <span
        aria-hidden="true"
        className={cn(
          'relative ml-4 h-6 w-px sm:mx-4 sm:h-px sm:w-auto sm:min-w-12 sm:flex-1',
          linked
            ? 'bg-action/50'
            : target === null
              ? 'border-l border-dashed border-white/15 sm:border-t sm:border-l-0'
              : 'border-l border-dashed border-warning/50 sm:border-t sm:border-l-0',
        )}
      >
        {linked ? (
          <ArrowRightIcon className="absolute top-1/2 right-0 hidden size-3.5 -translate-y-1/2 translate-x-1/2 text-action sm:block" />
        ) : null}
      </span>
      {target === null ? (
        <Workspace caption="Choose where reviewed workflows go" />
      ) : target.status === 'available' ? (
        <Workspace
          name={target.name}
          caption={
            target.requireApproval
              ? 'Needs approval there'
              : 'Arrives as a draft or goes live'
          }
          lit
        />
      ) : (
        <Workspace caption={target.reason} warning />
      )}
    </figure>
  );
}

function Workspace({
  name,
  caption,
  lit = false,
  warning = false,
}: Readonly<{
  name?: string;
  caption: string;
  lit?: boolean;
  warning?: boolean;
}>) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-lg border font-mono text-xs font-semibold',
          lit && 'border-action/40 bg-action/8 text-accent-foreground',
          !lit &&
            !warning &&
            'border-dashed border-white/20 text-subtle-foreground',
          warning && 'border-dashed border-warning/50 text-warning',
        )}
      >
        {name === undefined ? '?' : formatInitials(name)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {name ?? (warning ? 'Unavailable' : 'No workspace linked')}
        </p>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>
    </div>
  );
}
