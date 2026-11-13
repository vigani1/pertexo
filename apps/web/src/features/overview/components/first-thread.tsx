import { Link } from '@tanstack/react-router';
import { PlayIcon } from 'lucide-react';
import { ProgressButton } from '@/components/ui/progress-button';
import { cn } from '@/lib/class-names';
import type {
  FirstThreadDestination,
  FirstThreadStep,
} from '../model/first-thread';

const linkClass =
  'text-sm font-semibold text-foreground outline-none hover:text-accent-foreground focus-ring rounded-sm';

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
          {label}
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
          {label}
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
          {label}
        </Link>
      );
    case 'alerts':
      return (
        <Link
          to="/w/$workspaceId/settings/alerts"
          params={{ workspaceId }}
          className={linkClass}
        >
          {label}
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
          {label}
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
 * A new workspace's first thread: the steps to a first real run, each tied
 * off with a knot along one line as it's done.
 */
export function FirstThread({
  steps,
  workspaceId,
  firstRun,
}: Readonly<{
  steps: readonly FirstThreadStep[];
  workspaceId: string;
  firstRun?: FirstRunOffer | undefined;
}>) {
  const done = steps.filter((step) => step.done).length;
  return (
    <section
      aria-labelledby="first-thread-title"
      className="rounded-xl border border-surface-ink/6 bg-linear-to-b from-surface-ink/[0.02] to-transparent p-5 sm:p-7"
    >
      <h2 id="first-thread-title" className="text-2xl font-semibold">
        Your first thread
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {String(done)} of {String(steps.length)} done. Once something runs, this
        space shows every run as it happens.
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
      <ol className="relative mt-6 flex flex-col gap-5 pl-7">
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
