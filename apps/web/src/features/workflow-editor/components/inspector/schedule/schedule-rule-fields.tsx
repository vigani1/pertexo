import { useId } from 'react';
import {
  Field,
  FieldDescription,
  FieldError,
  LabelledField,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { describeMisfirePolicy } from '@/features/catalog/presentation.public';
import { fieldControlId } from '../../../model/node-form';
import {
  timezoneChoices,
  type ScheduleDraft,
  type ScheduleIssue,
  type ScheduleSchema,
} from '../../../model/schedule-draft';
import { ChoiceSelect } from '../choice-select';

/** What every builder control needs: the draft, its issue and a way to edit. */
export type RuleFieldProps = Readonly<{
  nodeId: string;
  draft: ScheduleDraft;
  issue: ScheduleIssue | undefined;
  disabled: boolean;
  onChange: (patch: Partial<ScheduleDraft>) => void;
}>;

function messageFor(
  issue: ScheduleIssue | undefined,
  field: ScheduleIssue['field'],
): string | undefined {
  return issue?.field === field ? issue.message : undefined;
}

/** “Every N minutes or hours”. */
export function EveryField({
  nodeId,
  draft,
  issue,
  disabled,
  onChange,
}: RuleFieldProps) {
  return (
    <LabelledField
      id={fieldControlId(nodeId, 'intervalMinutes')}
      label="Every"
      error={messageFor(issue, 'every')}
      thread={messageFor(issue, 'every') === undefined ? undefined : 'invalid'}
    >
      {(control) => (
        <div className="flex items-center gap-2">
          <Input
            {...control}
            name="schedule.every"
            autoComplete="off"
            inputMode="numeric"
            className="w-24 font-mono"
            value={draft.every}
            disabled={disabled}
            onChange={(event) => {
              onChange({ every: event.currentTarget.value });
            }}
          />
          <ToggleGroup
            aria-label="Unit"
            value={[draft.unit]}
            disabled={disabled}
            onValueChange={(values) => {
              const unit: unknown = values[0];
              if (unit === 'minutes' || unit === 'hours') onChange({ unit });
            }}
          >
            <ToggleGroupItem value="minutes">minutes</ToggleGroupItem>
            <ToggleGroupItem value="hours">hours</ToggleGroupItem>
          </ToggleGroup>
        </div>
      )}
    </LabelledField>
  );
}

/** The time of day a daily, weekday or weekly rule runs at. */
export function TimeField({
  nodeId,
  draft,
  issue,
  disabled,
  onChange,
}: RuleFieldProps) {
  const error = messageFor(issue, 'time');
  return (
    <LabelledField
      id={fieldControlId(nodeId, 'expression')}
      label="At"
      error={error}
      thread={error === undefined ? undefined : 'invalid'}
    >
      {(control) => (
        <Input
          {...control}
          type="time"
          name="schedule.time"
          className="w-32 font-mono"
          value={draft.time}
          disabled={disabled}
          onChange={(event) => {
            onChange({ time: event.currentTarget.value });
          }}
        />
      )}
    </LabelledField>
  );
}

const WEEK = [
  [1, 'Mon', 'Monday'],
  [2, 'Tue', 'Tuesday'],
  [3, 'Wed', 'Wednesday'],
  [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'],
  [6, 'Sat', 'Saturday'],
  [0, 'Sun', 'Sunday'],
] as const;

/** The days a weekly rule runs on, Monday first. */
export function DaysField({
  draft,
  issue,
  disabled,
  onChange,
}: RuleFieldProps) {
  const labelId = useId();
  const error = messageFor(issue, 'days');
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <span
        id={labelId}
        className="text-[0.8rem] font-semibold text-foreground/85"
      >
        On
      </span>
      <ToggleGroup
        multiple
        aria-labelledby={labelId}
        value={draft.days.map(String)}
        disabled={disabled}
        className="w-full justify-between"
        onValueChange={(values) => {
          onChange({ days: values.map(Number) });
        }}
      >
        {WEEK.map(([day, short, name]) => (
          <ToggleGroupItem
            key={day}
            value={String(day)}
            aria-label={name}
            className="px-2"
          >
            {short}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {error === undefined ? null : <FieldError>{error}</FieldError>}
    </Field>
  );
}

/** A five-field cron rule, for anything the presets can't say. */
export function CronField({
  nodeId,
  draft,
  issue,
  disabled,
  onChange,
}: RuleFieldProps) {
  const error = messageFor(issue, 'expression');
  return (
    <LabelledField
      id={fieldControlId(nodeId, 'expression')}
      label="Cron rule"
      description="Minute, hour, day of month, month and day of week, like 0 9 * * 1-5."
      error={error}
      thread={error === undefined ? undefined : 'invalid'}
    >
      {(control) => (
        <Input
          {...control}
          name="schedule.expression"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={draft.expression}
          disabled={disabled}
          onChange={(event) => {
            onChange({ expression: event.currentTarget.value });
          }}
        />
      )}
    </LabelledField>
  );
}

/** The place whose local clock a cron rule follows. */
export function TimezoneField({
  nodeId,
  draft,
  issue,
  disabled,
  onChange,
}: RuleFieldProps) {
  const error = messageFor(issue, 'timezone');
  return (
    <LabelledField
      id={fieldControlId(nodeId, 'timezone')}
      label="Timezone"
      error={error}
      thread={error === undefined ? undefined : 'invalid'}
    >
      {(control) => (
        <ChoiceSelect
          id={control.id}
          invalid={control['aria-invalid']}
          {...(control['aria-describedby'] === undefined
            ? {}
            : { describedBy: control['aria-describedby'] })}
          value={draft.timezone === '' ? null : draft.timezone}
          disabled={disabled}
          choices={[
            ...(draft.timezone === ''
              ? [{ value: null, label: 'Choose a timezone' }]
              : []),
            ...timezoneChoices(draft.timezone).map((zone) => ({
              value: zone,
              label: zone.replaceAll('_', ' '),
            })),
          ]}
          onChange={(zone) => {
            onChange({ timezone: zone ?? '' });
          }}
        />
      )}
    </LabelledField>
  );
}

const MISFIRE_LABELS: Readonly<Record<string, string>> = {
  catch_up_once: 'Run the latest',
  skip: 'Skip them',
};

/** What happens to runs Pertexo couldn't start on time (ADR 014). */
export function MisfireField({
  draft,
  misfire,
  disabled,
  onChange,
}: Readonly<{
  draft: ScheduleDraft;
  misfire: NonNullable<ScheduleSchema['misfire']>;
  disabled: boolean;
  onChange: (patch: Partial<ScheduleDraft>) => void;
}>) {
  const labelId = useId();
  const policy = draft.misfirePolicy;
  return (
    <Field>
      <span
        id={labelId}
        className="text-[0.8rem] font-semibold text-foreground/85"
      >
        If runs are missed
      </span>
      <ToggleGroup
        aria-labelledby={labelId}
        value={[policy]}
        disabled={disabled}
        onValueChange={(values) => {
          const next: unknown = values[0];
          if (typeof next === 'string') onChange({ misfirePolicy: next });
        }}
      >
        {misfire.policies.map((value) => (
          <ToggleGroupItem key={value} value={value}>
            {MISFIRE_LABELS[value] ?? value}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {policy === 'catch_up_once' || policy === 'skip' ? (
        <FieldDescription>{describeMisfirePolicy(policy)}</FieldDescription>
      ) : null}
    </Field>
  );
}
