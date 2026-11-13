import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, PlayIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ProgressButton } from '@/components/ui/progress-button';
import { cn } from '@/lib/class-names';
import type {
  FirstThreadDestination,
  FirstThreadStep,
} from '../model/first-thread';

// Each task reads as a link: the action's colour, an arrow, an underline on hover.
const linkClass =
  'group/step inline-flex items-center gap-1 rounded-sm text-sm font-semibold text-accent-foreground underline-offset-4 outline-none hover:underline focus-ring';

function StepLabel({ label }: Readonly<{ label: string }>): ReactNode {
  return (
    <>
      {label}
      <ArrowRightIcon
        aria-hidden="true"
        className="size-3.5 transition-transform group-hover/step:translate-x-0.5 motion-reduce:transition-none"
      />
    </>
  );
}

function StepLink({
  destination,
  workspaceId,
  label,
}: Readonly<{
  destination: FirstThreadDestination;
  workspaceId: string;
  label: string;
}>) {
  switch (destination.to) {
    case 'workflow':
      return (
        <Link
          to="/w/$workspaceId/workflows/$workflowId"
          params={{ workspaceId, workflowId: destination.workflowId }}
          className={linkClass}
        >
          <StepLabel label={label} />
        </Link>
      );
    case 'workflows':
      return (
        <Link
          to="/w/$workspaceId/workflows"
          params={{ workspaceId }}
          search={(destination.create ?? false) ? { create: true } : {}}
          className={linkClass}
        >
          <StepLabel label={label} />
        </Link>
      );
    case 'connections':
      return (
        <Link
          to="/w/$workspaceId/connections"
          params={{ workspaceId }}
          search={{ add: destination.add }}
          className={linkClass}
        >
          <StepLabel label={label} />
        </Link>
      );
    case 'alerts':
      return (
        <Link
          to="/w/$workspaceId/settings/alerts"
          params={{ workspaceId }}
          className={linkClass}
        >
          <StepLabel label={label} />
        </Link>
      );
    case 'team':
      return (
        <Link
          to="/w/$workspaceId/team"
          params={{ workspaceId }}
          search={{ invite: destination.invite }}
          className={linkClass}
        >
          <StepLabel label={label} />
        </Link>
      );
  }
}

/** A one-click first run: the example with nothing to set up. */
export type FirstRunOffer = Readonly<{
  starting: boolean;
  onStart: () => void;
}>;

/**
 * Getting started: the setup tasks that are still worth doing, each a link
 * to where it's done, tied off along one line as it's done. A new
 * workspace sees it first, with a one-click example run; later it stays,
 * quieter, until every task is done.
 */
export function FirstThread({
  steps,
  workspaceId,
  firstRun,
  compact = false,
}: Readonly<{
  steps: readonly FirstThreadStep[];
  workspaceId: string;
  firstRun?: FirstRunOffer | undefined;
  /** After the first run: the remaining tasks, below what's running. */
  compact?: boolean;
}>) {
  const done = steps.filter((step) => step.done).length;
  return (
    <section
      aria-labelledby="first-thread-title"
      className={cn(
        'rounded-xl border border-surface-ink/6 bg-linear-to-b from-surface-ink/[0.02] to-transparent',
        compact ? 'p-4 sm:p-5' : 'p-5 sm:p-7',
      )}
    >
      <h2
        id="first-thread-title"
        className={cn('font-semibold', compact ? 'text-lg' : 'text-2xl')}
      >
        Getting started
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {String(done)} of {String(steps.length)} done.
        {compact
          ? ' The rest are here whenever you want them.'
          : ' Once something runs, this page shows every run as it happens.'}
      </p>
      {firstRun === undefined ? null : (
        <div className="mt-5 flex flex-col items-start gap-2 rounded-lg border border-primary/20 bg-primary/[0.04] p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            <span className="font-semibold">See a run in about a minute.</span>{' '}
            <span className="text-muted-foreground">
              Create a ready-made example that needs nothing set up, then
              publish and run it with a guide.
            </span>
          </p>
          <ProgressButton
            type="button"
            variant="primary"
            pending={firstRun.starting}
            pendingLabel="Setting it up…"
            icon={<PlayIcon aria-hidden="true" data-icon="inline-start" />}
            className="shrink-0"
            onClick={firstRun.onStart}
          >
            Try the example
          </ProgressButton>
        </div>
      )}
      <ol
        className={cn(
          'relative flex flex-col pl-7',
          compact ? 'mt-4 gap-3' : 'mt-6 gap-5',
        )}
      >
        <span
          aria-hidden="true"
          className="absolute top-2 bottom-2 left-[0.4rem] w-0.5 rounded-full bg-surface-ink/8"
        />
        {steps.map((step) => (
          <li key={step.key} className="relative">
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-1 -left-7 size-3.5 rounded-full border-2',
                step.done
                  ? 'border-success bg-success shadow-[0_0_0_4px_color-mix(in_srgb,var(--success)_15%,transparent)]'
                  : 'border-surface-ink/20 bg-background',
              )}
            />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <StepLink
                destination={step.destination}
                workspaceId={workspaceId}
                label={step.label}
              />
              <span
                className={cn(
                  'text-xs',
                  step.done ? 'text-success' : 'text-subtle-foreground',
                )}
              >
                {step.done ? 'Done' : 'To do'}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{step.hint}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
