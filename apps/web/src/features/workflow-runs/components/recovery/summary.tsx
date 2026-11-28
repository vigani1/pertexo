import type { ReactNode } from 'react';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import {
  StatusMark,
  type StatusTone,
} from '@/components/patterns/status/status-mark';
import { formatCount } from '@/lib/format/count';
import type { RunTimelineRow } from '../../model/timeline/runs';

const RECOVERY_STEP_PREVIEW = 5;

export function RecoverySummary({
  rows,
  actions,
  canCheckRetry,
  canReplay,
}: Readonly<{
  rows: readonly RunTimelineRow[];
  actions: ReactNode;
  canCheckRetry: boolean;
  canReplay: boolean;
}>) {
  const completed = rows.filter((row) => row.status === 'succeeded');
  const unfinished = rows.filter(
    (row) =>
      row.status === 'failed' ||
      row.status === 'timed_out' ||
      row.status === 'not_started',
  );
  return (
    <section aria-labelledby="run-recovery-title" className="grid w-full gap-4">
      <RuleHeading id="run-recovery-title">
        Where this leaves the run
      </RuleHeading>
      <div className="grid gap-4 lg:grid-cols-3 lg:gap-7">
        <RecoveryFact title="Done, stays done" tone="success">
          {completed.length === 0 ? (
            'No completed steps were recorded.'
          ) : (
            <>
              {formatCount(completed.length, 'step')} completed.{' '}
              {stepNames(completed)}
            </>
          )}
        </RecoveryFact>
        <RecoveryFact title="Not done" tone="failure">
          {unfinished.length === 0 ? (
            'The run did not complete.'
          ) : (
            <>
              {formatCount(unfinished.length, 'step')} did not complete.{' '}
              {stepNames(unfinished)}
            </>
          )}
        </RecoveryFact>
        <RecoveryFact title="Safe to do now" tone="attention">
          {canCheckRetry
            ? 'Check whether you can retry from the failed step. A retry that uses saved results keeps earlier steps from running again.'
            : 'Review the step history and check any earlier effects.'}
          {canReplay
            ? ' A full replay starts from the beginning and can repeat earlier effects.'
            : null}
        </RecoveryFact>
      </div>
      {actions}
    </section>
  );
}

function RecoveryFact({
  title,
  tone,
  children,
}: Readonly<{ title: string; tone: StatusTone; children: ReactNode }>) {
  return (
    <div className="grid content-start gap-2 border-t border-border pt-3">
      <h3 className="flex items-center gap-2 font-semibold">
        <StatusMark display="mark" tone={tone} />
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

function stepNames(rows: readonly RunTimelineRow[]) {
  const preview = rows
    .slice(0, RECOVERY_STEP_PREVIEW)
    .map((row) => row.label)
    .join(', ');
  const remaining = rows.length - RECOVERY_STEP_PREVIEW;
  return remaining > 0
    ? `${preview} and ${String(remaining)} more.`
    : `${preview}.`;
}
