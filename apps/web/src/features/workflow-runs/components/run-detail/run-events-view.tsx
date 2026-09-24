import type { WorkflowRunEvent } from '@pertexo/contracts/schemas/workflow-runs';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import { describeRunEvent } from '../../model/event-copy';

/**
 * A readable log of the run's events: offset from the start, the step's name
 * and what happened. The raw event type stays in mono for support.
 */
export function RunEventsView({
  events,
  truncatedCount,
  runStartMs,
  stepLabel,
  recoveryMessage,
  onViewOutput,
}: Readonly<{
  events: readonly WorkflowRunEvent[];
  truncatedCount: number;
  runStartMs: number;
  stepLabel: (event: WorkflowRunEvent) => string | undefined;
  recoveryMessage: string | undefined;
  onViewOutput: (invocationKey: string) => void;
}>) {
  const lines = events.map((event) =>
    describeRunEvent(event, runStartMs, stepLabel),
  );
  return (
    <div className="flex flex-col gap-3">
      {recoveryMessage === undefined ? null : (
        <p role="status" className="text-sm text-warning">
          {recoveryMessage}
        </p>
      )}
      {truncatedCount > 0 ? (
        <p className="text-xs text-subtle-foreground">
          {String(truncatedCount)} older events aren’t shown here.
        </p>
      ) : null}
      {lines.length === 0 ? (
        <p className="py-10 text-sm text-muted-foreground">
          Waiting for the run’s first event…
        </p>
      ) : (
        <ol aria-label="Run events" className="flex flex-col">
          {lines.map((line) => (
            <li
              key={line.sequence}
              className="group/event grid grid-cols-[4.75rem_1rem_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-white/6 py-2.5 text-[0.82rem]"
            >
              <span className="pt-px font-mono text-[0.7rem] text-subtle-foreground">
                {line.offset}
              </span>
              <StatusGlyph tone={line.tone} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block">
                  {line.step === undefined ? null : (
                    <b className="font-semibold">{line.step} · </b>
                  )}
                  {line.sentence}
                </span>
                <span className="block font-mono text-[0.68rem] text-subtle-foreground/80">
                  {line.rawType}
                </span>
              </span>
              {line.hasOutput && line.invocationKey !== undefined ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    if (line.invocationKey !== undefined)
                      onViewOutput(line.invocationKey);
                  }}
                >
                  View output
                </Button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
