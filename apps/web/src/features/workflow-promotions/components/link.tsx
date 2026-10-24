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
  const { linked, label, threadClass } = promotionPresentation(target);
  return (
    <figure
      aria-label={label}
      className="flex flex-col gap-3 rounded-xl border border-surface-ink/7 bg-surface-ink/[0.02] p-5 sm:flex-row sm:items-center sm:gap-0"
    >
      <Workspace name={workspaceName} caption="This workspace" lit />
      <span
        aria-hidden="true"
        className={cn(
          'relative ml-4 h-6 w-px sm:mx-4 sm:h-px sm:w-auto sm:min-w-12 sm:flex-1',
          threadClass,
        )}
      >
        {linked ? (
          <ArrowRightIcon className="absolute top-1/2 right-0 hidden size-3.5 -translate-y-1/2 translate-x-1/2 text-action sm:block" />
        ) : null}
      </span>
      <TargetWorkspace target={target} />
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
  const unlinked = !lit && !warning;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-lg border font-mono text-xs font-semibold',
          lit && 'border-action/40 bg-action/8 text-accent-foreground',
          unlinked &&
            'border-dashed border-surface-ink/20 text-subtle-foreground',
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

function promotionPresentation(target: WorkflowPromotionSettings['target']) {
  if (target === null)
    return {
      linked: false,
      label: 'No workspace linked',
      threadClass:
        'border-l border-dashed border-surface-ink/15 sm:border-t sm:border-l-0',
    };
  if (target.status === 'available')
    return {
      linked: true,
      label: `Promotes to ${target.name}`,
      threadClass: 'bg-action/50',
    };
  return {
    linked: false,
    label: 'The linked workspace is unavailable',
    threadClass:
      'border-l border-dashed border-warning/50 sm:border-t sm:border-l-0',
  };
}

function TargetWorkspace({
  target,
}: Readonly<{ target: WorkflowPromotionSettings['target'] }>) {
  if (target === null)
    return <Workspace caption="Choose where reviewed workflows go" />;
  if (target.status === 'available')
    return (
      <Workspace
        name={target.name}
        caption={
          target.requireApproval
            ? 'Needs approval there'
            : 'Arrives as a draft or goes live'
        }
        lit
      />
    );
  return <Workspace caption={target.reason} warning />;
}
