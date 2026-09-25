import { Notice } from '@/components/ui/notice';
import type { LoopSummary } from '../../model/graph-adapter';

/**
 * A For each step's body in words (ADR 020): it runs once per item, within
 * its item and concurrency bounds, and the steps after it wait for every
 * item. Read-only, because bodies can't be built on the canvas yet.
 */
export function LoopBodySummary({
  loop,
}: Readonly<{ loop: LoopSummary | null }>) {
  if (loop === null)
    return (
      <Notice tone="warning" title="No body yet">
        A For each runs the steps inside it once per item. Bodies can’t be built
        on the canvas yet, so this step can’t run until one is added.
      </Notice>
    );
  const items = loop.maxIterations === 1 ? 'item' : 'items';
  return (
    <section
      aria-labelledby="loop-body-summary"
      className="flex flex-col gap-2 rounded-lg border border-dashed border-secondary/30 bg-secondary/[0.04] p-3 text-sm"
    >
      <h3 id="loop-body-summary" className="font-semibold">
        Runs once per item
      </h3>
      <p className="text-muted-foreground">
        Its body runs for each item it’s given, up to {loop.maxIterations}{' '}
        {items} and {loop.maxConcurrency} at a time. Steps after it continue
        once every item has finished.
      </p>
      <ul aria-label="Body steps" className="flex flex-col gap-1">
        {loop.steps.map((step) => (
          <li
            key={step.id}
            className="truncate rounded-sm border border-white/6 bg-white/4 px-2 py-1 text-[0.8rem]"
          >
            {step.title}
          </li>
        ))}
      </ul>
      <p className="text-xs text-subtle-foreground">
        The body is kept exactly as it is; its steps can’t be edited on the
        canvas yet.
      </p>
    </section>
  );
}
