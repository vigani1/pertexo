import type { ReactNode } from 'react';
import type { ScheduleTriggerHealthResponse } from '@pertexo/contracts';
import { StepTile } from '@/features/catalog/catalog-views.public';
import {
  describeStep,
  describeMisfirePolicy,
  describeRecurrence,
} from '@/features/catalog/public';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { Switch } from '@/components/ui/switch';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { describeScheduleHold } from '../../../model/triggers/occurrence-outcome';
import { describeTriggerState } from '../../../model/triggers/trigger-state';
import { TriggerRow } from '../trigger-row';

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
  const state = describeTriggerState(trigger);
  const hold = describeScheduleHold(trigger);
  const enabled = trigger.status !== 'disabled';
  return (
    <TriggerRow
      label={`Schedule: ${stepName}`}
      icon={<StepTile step={describeStep('core.schedule')} />}
      name={stepName}
      kind={
        <>
          Schedule ·{' '}
          {trigger.recurrence === null
            ? 'needs repair'
            : describeRecurrence(trigger.recurrence)}
          {trigger.recurrence?.kind === 'cron'
            ? `, ${trigger.recurrence.timezone}`
            : null}
        </>
      }
      extra={
        hold === undefined ? undefined : (
          <Notice tone="warning" className="mt-2">
            {hold}
          </Notice>
        )
      }
      state={
        <>
          <StatusMark tone={state.tone}>{state.label}</StatusMark>
          <span className="text-meta text-subtle-foreground">
            {trigger.lastFireAt === null ? (
              'Not run yet'
            ) : (
              <>
                Last run{' '}
                <time
                  dateTime={trigger.lastFireAt}
                  title={formatDateTime(trigger.lastFireAt)}
                >
                  {formatRelativeTime(trigger.lastFireAt)}
                </time>
              </>
            )}
          </span>
        </>
      }
      control={
        editable ? (
          <span className="flex items-center gap-2 pt-0.5">
            {pending ? <LoadingOrb /> : null}
            <Switch
              aria-label={`${stepName} schedule on`}
              checked={enabled}
              disabled={disabled}
              onCheckedChange={(next) => {
                onEnabledChange(next);
              }}
            />
          </span>
        ) : undefined
      }
      detailsLabel="Runs"
      details={
        <>
          {nextRuns}
          {/* A rule, not a reading, so a note rather than a value. */}
          <p className="text-meta text-subtle-foreground">
            {describeMisfirePolicy(trigger.misfirePolicy)}
          </p>
          {history}
        </>
      }
    />
  );
}
