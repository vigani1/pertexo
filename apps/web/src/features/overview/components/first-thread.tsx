import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import type {
  FirstThreadDestination,
  FirstThreadStep,
} from '../model/first-thread';

const linkClass =
  'text-sm font-semibold text-foreground outline-none hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/60 rounded-sm';

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
          className={linkClass}
        >
          {label}
        </Link>
      );
    case 'alerts':
      return (
        <Link
          to="/w/$workspaceId/alerts"
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
          className={linkClass}
        >
          {label}
        </Link>
      );
  }
}

/**
 * A new workspace's first thread: the steps to a first real run, each tied
 * off with a knot along one line as it's done.
 */
export function FirstThread({
  steps,
  workspaceId,
}: Readonly<{ steps: readonly FirstThreadStep[]; workspaceId: string }>) {
  const done = steps.filter((step) => step.done).length;
  return (
    <section
      aria-labelledby="first-thread-title"
      className="rounded-xl border border-white/6 bg-linear-to-b from-white/[0.02] to-transparent p-5 sm:p-7"
    >
      <h2 id="first-thread-title" className="text-2xl font-semibold">
        Your first thread
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {String(done)} of {String(steps.length)} done. Once something runs, this
        space shows every run as it happens.
      </p>
      <ol className="relative mt-6 flex flex-col gap-5 pl-7">
        <span
          aria-hidden="true"
          className="absolute top-2 bottom-2 left-[0.4rem] w-0.5 rounded-full bg-white/8"
        />
        {steps.map((step) => (
          <li key={step.key} className="relative">
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-1 -left-7 size-3.5 rounded-full border-2',
                step.done
                  ? 'border-success bg-success shadow-[0_0_0_4px_color-mix(in_srgb,var(--success)_15%,transparent)]'
                  : 'border-white/20 bg-background',
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
