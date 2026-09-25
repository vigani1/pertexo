import { useId, type ReactNode } from 'react';
import type { ScheduleTriggerHealthResponse } from '@pertexo/contracts/schemas/schedules';
import { CalendarClockIcon } from 'lucide-react';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { Switch } from '@/components/ui/switch';
import {
  describeMisfirePolicy,
  describeRecurrence,
} from '@/features/catalog/presentation.public';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { describeScheduleHold } from '../../model/occurrence-outcome';
import { describeTriggerState } from '../../model/trigger-state';

function When({
  label,
  value,
  empty,
}: Readonly<{ label: string; value: string | null; empty: string }>) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">
        {value === null ? (
          <span className="text-subtle-foreground">{empty}</span>
        ) : (
          <>
            <time dateTime={value} className="font-medium">
              {formatRelativeTime(value)}
            </time>
            <span className="block font-mono text-[0.72rem] text-subtle-foreground">
              {formatDateTime(value)}
            </span>
          </>
        )}
      </dd>
    </div>
  );
}

/**
 * One schedule: its rule as a sentence, when it runs next and last, what
 * happens to a missed run, the switch that pauses it and what it did.
 */
export function ScheduleCard({
  trigger,
  stepName,
  editable,
  pending,
  disabled,
  onEnabledChange,
  nextRuns,
  history,
}: Readonly<{
  trigger: ScheduleTriggerHealthResponse;
  stepName: string;
  editable: boolean;
  pending: boolean;
  disabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Upcoming run times, composed by the section that can read them. */
  nextRuns?: ReactNode;
  /** Recorded run times, composed by the section that can read them. */
  history?: ReactNode;
}>) {
  const switchId = useId();
  const state = describeTriggerState(trigger);
  const hold = describeScheduleHold(trigger);
  const enabled = trigger.status !== 'disabled';
  return (
    <article
      aria-label={`Schedule: ${stepName}`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card/50 p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-secondary/25 bg-secondary/8 text-secondary">
            <CalendarClockIcon aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{stepName}</h3>
            <Status tone={state.tone} className="mt-1 text-xs">
              {state.label}
            </Status>
          </div>
        </div>
        {editable ? (
          <label
            htmlFor={switchId}
            className="flex cursor-pointer items-center gap-2.5 text-sm text-muted-foreground"
          >
            {pending ? <LoadingOrb /> : null}
            Schedule on
            <Switch
              id={switchId}
              checked={enabled}
              disabled={disabled}
              onCheckedChange={(next) => {
                onEnabledChange(next);
              }}
            />
          </label>
        ) : null}
      </header>
      <p className="font-heading text-xl leading-snug font-semibold tracking-[-0.02em]">
        {describeRecurrence(trigger.recurrence)}
        {trigger.recurrence.kind === 'cron' ? (
          <span className="ml-2 font-mono text-xs font-normal tracking-normal text-subtle-foreground">
            {trigger.recurrence.timezone}
          </span>
        ) : null}
      </p>
      {hold === undefined ? null : <Notice tone="warning">{hold}</Notice>}
      {nextRuns}
      <dl className="grid gap-4 sm:grid-cols-2">
        <When label="Last run" value={trigger.lastFireAt} empty="Not yet" />
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Missed runs</dt>
          <dd className="text-sm text-muted-foreground">
            {describeMisfirePolicy(trigger.misfirePolicy)}
          </dd>
        </div>
      </dl>
      {history}
    </article>
  );
}
