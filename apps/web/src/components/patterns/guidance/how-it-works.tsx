import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type HowItWorksStep = Readonly<{ title: string; body: ReactNode }>;

/**
 * A page's workings in a few steps, strung on one thread: each step is a bead
 * with a short title and a sentence. Across on a wide screen, down a phone.
 */
export function HowItWorks({
  title,
  steps,
  className,
}: Readonly<{
  title: string;
  steps: readonly HowItWorksStep[];
  className?: string;
}>) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex flex-col gap-5', className)}
    >
      <h2
        id={headingId}
        className="text-sm font-semibold text-muted-foreground"
      >
        {title}
      </h2>
      {/* The thread the beads sit on: along the top on a wide screen, down
          the left edge on a phone. */}
      <ol className="relative grid gap-6 before:absolute before:top-1 before:bottom-1 before:left-[0.3125rem] before:w-px before:bg-linear-to-b before:from-primary/50 before:via-white/12 before:to-transparent before:content-[''] sm:grid-cols-3 sm:gap-8 sm:before:top-[0.3125rem] sm:before:right-0 sm:before:bottom-auto sm:before:left-0 sm:before:h-px sm:before:w-auto sm:before:bg-linear-to-r">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className="relative flex gap-4 sm:flex-col sm:gap-3"
          >
            <span
              aria-hidden="true"
              className={cn(
                'relative mt-0.5 size-2.5 shrink-0 rounded-full ring-4 ring-background sm:mt-0',
                index === 0 ? 'bg-action' : 'border border-primary/60 bg-card',
              )}
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold">
                <span className="mr-2 font-mono text-xs font-normal text-subtle-foreground">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {step.title}
              </span>
              <span className="text-sm leading-relaxed text-muted-foreground">
                {step.body}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
