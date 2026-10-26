import { useId } from 'react';
import {
  PENDING_TASK_LIMITS,
  TIMED_OUT_PORT,
  type ApprovalConfig,
} from '@pertexo/workflow-model';
import { ChoiceCards } from '@/components/patterns/choice-cards';
import { StatusGlyph } from '@/components/ui/status';
import { TimedOutGlyph } from '@/features/catalog/presentation.public';
import { formatTimeSpan } from '@/lib/format/time';
import { cn } from '@/lib/utils';
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { DurationField } from '../fields/duration';

type OnExpiry = ApprovalConfig['onExpiry'];

const { minimumExpirySeconds: MINIMUM, maximumExpirySeconds: MAXIMUM } =
  PENDING_TASK_LIMITS;

/** Where a window sits between 1 hour and 30 days, on a log scale (0–1). */
function windowShare(seconds: number): number {
  const clamped = Math.min(Math.max(seconds, MINIMUM), MAXIMUM);
  return Math.log(clamped / MINIMUM) / Math.log(MAXIMUM / MINIMUM);
}

const TICKS = [
  { seconds: 3_600, label: '1h' },
  { seconds: 86_400, label: '1d' },
  { seconds: 604_800, label: '1w' },
  { seconds: 2_592_000, label: '30d' },
] as const;

/** A point along the bar's inner track, which leaves room for its end marks. */
function alongTrack(share: number): string {
  return `calc(0.5rem + (100% - 1rem) * ${String(share)})`;
}

/**
 * The task's window as a slim thread: it opens at the step, waits (violet,
 * like any waiting run) and ends at the expiry, where it either stops at a
 * cross or carries on as the amber Timed out path.
 */
function ExpiryTimeline({
  seconds,
  onExpiry,
}: Readonly<{ seconds: number; onExpiry: OnExpiry }>) {
  const share = windowShare(seconds);
  const end = alongTrack(share);
  const continues = onExpiry === 'continue';
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden="true" className="relative h-9">
        <span className="absolute inset-x-2 top-[9px] h-[3px] rounded-full bg-surface-ink/8" />
        {TICKS.map((tick, index) => (
          <span
            key={tick.label}
            className="absolute top-[18px] flex flex-col items-center gap-0.5"
            style={{
              left: alongTrack(windowShare(tick.seconds)),
              transform: `translateX(${tickOffset(index)})`,
            }}
          >
            <span className="h-1 w-px bg-surface-ink/20" />
            <span className="font-mono text-[0.625rem] leading-none text-subtle-foreground">
              {tick.label}
            </span>
          </span>
        ))}
        <span
          className="absolute left-2 top-[9px] h-[3px] rounded-full bg-secondary shadow-[0_0_8px_color-mix(in_srgb,var(--secondary)_45%,transparent)] transition-[width] duration-300 ease-unspool motion-reduce:transition-none"
          style={{ width: `calc((100% - 1rem) * ${String(share)})` }}
        />
        {continues ? (
          <span
            className="absolute top-[10px] right-2 border-t-[1.5px] border-dashed border-warning/75 transition-[left] duration-300 ease-unspool motion-reduce:transition-none"
            style={{ left: end }}
          />
        ) : null}
        <span className="absolute top-[4.5px] left-[calc(0.5rem-6px)] size-3 rounded-full border-2 border-secondary bg-card" />
        <span
          className={cn(
            'absolute top-[2.5px] grid size-4 -translate-x-1/2 place-items-center rounded-full bg-card transition-[left] duration-300 ease-unspool motion-reduce:transition-none',
            continues ? 'text-warning' : 'text-destructive',
          )}
          style={{ left: end }}
        >
          {continues ? (
            <TimedOutGlyph className="size-3.5" />
          ) : (
            <StatusGlyph tone="failure" still className="size-3.5" />
          )}
        </span>
      </div>
      <div className="flex min-h-8 items-start justify-between gap-3 text-xs leading-snug">
        <p className="min-w-0 flex-1 text-muted-foreground">
          Opens when the run reaches this step
        </p>
        <p className="shrink-0 text-right text-muted-foreground">
          Expires after{' '}
          <span className="font-medium text-foreground tabular-nums">
            {formatTimeSpan(seconds)}
          </span>
          <br />
          <span className={continues ? 'text-warning' : 'text-destructive'}>
            {continues ? 'then continues on Timed out' : 'then fails the step'}
          </span>
        </p>
      </div>
    </div>
  );
}

// The first and last tick labels stay inside the bar's ends.
function tickOffset(index: number): string {
  if (index === 0) return '-0.25rem';
  if (index === TICKS.length - 1) return 'calc(-100% + 0.25rem)';
  return '-50%';
}

/**
 * When a person must answer, and what happens when nobody does: the window
 * as a timeline, its length, and the choice between failing the step and
 * continuing on the Timed out path.
 */
export function TaskExpiry({
  node,
  graph,
  form,
  kind,
  seconds,
  onExpiry,
}: Readonly<{
  node: WorkflowNode;
  graph: GraphLevel;
  form: NodeFormApi;
  kind: 'core.approval' | 'core.request_input';
  seconds: number;
  onExpiry: OnExpiry;
}>) {
  const headingId = useId();
  const timedOutLinked = graph.edges.some(
    (edge) =>
      edge.source.nodeId === node.id && edge.source.port === TIMED_OUT_PORT,
  );
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h3 id={headingId} className="-mb-1 font-medium">
        When the request expires
      </h3>
      <ExpiryTimeline seconds={seconds} onExpiry={onExpiry} />
      <DurationField
        // A step left on the default window has none in its setup.
        config={{ ...node.config, expiresAfterSeconds: seconds }}
        form={form}
        configKey="expiresAfterSeconds"
        label="Expires after"
        description="Counted from when the run reaches this step. From 1 hour to 30 days; 7 days if you leave it."
        minimumSeconds={MINIMUM}
        maximumSeconds={MAXIMUM}
      />
      <ChoiceCards
        legend="When nobody responds"
        value={onExpiry}
        disabled={!form.editable}
        onChange={(next) => {
          form.commit(
            (current) => ({ config: { ...current.config, onExpiry: next } }),
            `${form.nodeId}:task:on-expiry`,
          );
        }}
        choices={[
          {
            value: 'fail',
            label: 'Fail the step',
            hint: (
              <>
                The run fails with <em>expired</em>. A failure route can still
                handle it.
              </>
            ),
            glyph: <StatusGlyph tone="failure" still className="size-3.5" />,
            disabled: timedOutLinked,
          },
          {
            value: 'continue',
            label: 'Continue on Timed out',
            hint:
              kind === 'core.approval'
                ? 'The run continues on Timed out. Link it to escalate, or to the Approved step to approve by default.'
                : 'The run continues on Timed out. Link it to ask someone else or carry on without an answer.',
            glyph: <TimedOutGlyph className="size-3.5 text-warning" />,
          },
        ]}
      />
      {timedOutLinked && onExpiry === 'continue' ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          Remove the Timed out link to fail the step instead.
        </p>
      ) : null}
    </section>
  );
}
