import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import {
  describeDaylightSaving,
  describeRecurrence,
} from '@/features/catalog/presentation.public';
import { canonicalizeJson } from '@/lib/canonical-json';
import type { NodeConfig } from '../../../model/inspector-draft';
import { fieldControlId, type NodeFormApi } from '../../../model/node-form';
import {
  browserTimezone,
  configFromDraft,
  cronFor,
  draftFromConfig,
  recurrenceFor,
  scheduleIssue,
  type ScheduleDraft,
  type ScheduleMode,
  type ScheduleRecurrence,
  type ScheduleSchema,
} from '../../../model/schedule-draft';
import { useLiveField } from '../../../use-live-field';
import { ChoiceSelect } from '../choice-select';
import { DraftNextRuns } from './draft-next-runs';
import {
  CronField,
  DaysField,
  EveryField,
  MisfireField,
  TimeField,
  TimezoneField,
  type RuleFieldProps,
} from './schedule-rule-fields';

const MODES: readonly Readonly<{
  mode: ScheduleMode;
  label: string;
  kind: 'cron' | 'interval';
}>[] = [
  { mode: 'every', label: 'Every N minutes or hours', kind: 'interval' },
  { mode: 'daily', label: 'Daily at a time', kind: 'cron' },
  { mode: 'weekdays', label: 'Weekdays at a time', kind: 'cron' },
  { mode: 'weekly', label: 'Weekly on chosen days', kind: 'cron' },
  { mode: 'custom', label: 'Custom cron rule', kind: 'cron' },
];

const SCHEDULE_FIELD = 'schedule';

/**
 * The Schedule step's Setup: pick a kind of rule, fill it in, and read it
 * back as a sentence in its timezone. Like every inspector control it
 * applies live — a rule the schema accepts goes straight into the draft as
 * the step's usual config, and an unfinished one waits here with its reason.
 */
export function ScheduleBuilder({
  config,
  schema,
  form,
}: Readonly<{
  config: NodeConfig;
  schema: ScheduleSchema;
  form: NodeFormApi;
}>) {
  const [fallbackTimezone] = useState(browserTimezone);
  const live = useLiveField<NodeConfig, ScheduleDraft>({
    value: config,
    format: (value) => draftFromConfig(value, schema, fallbackTimezone),
    parse: (draft) => configFromDraft(draft, schema),
    equals: (left, right) => canonicalizeJson(left) === canonicalizeJson(right),
    commit: (next) => {
      form.commit({ config: next }, `${form.nodeId}:${SCHEDULE_FIELD}`);
    },
    onScratchChange: (scratch) => {
      form.reportScratch(SCHEDULE_FIELD, scratch);
    },
  });
  const draft = live.text;
  const issue =
    live.error === undefined ? undefined : scheduleIssue(draft, schema);
  const recurrence = recurrenceFor(draft, schema);
  const fieldProps: RuleFieldProps = {
    nodeId: form.nodeId,
    draft,
    issue,
    disabled: !form.editable,
    onChange: (patch) => {
      live.change({ ...draft, ...patch });
    },
  };
  const modes = MODES.filter(({ kind }) =>
    kind === 'cron' ? schema.cron !== undefined : schema.interval !== undefined,
  );
  return (
    // Leaving any of the rule's controls shows what's wrong with it.
    <div className="flex flex-col gap-4" onBlur={live.blur}>
      {config.kind === 'cron' || config.kind === 'interval' ? null : (
        <Notice
          tone="warning"
          title="Not scheduled yet"
          action={
            form.editable && recurrence !== undefined ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  live.change(draft);
                }}
              >
                Use this schedule
              </Button>
            ) : undefined
          }
        >
          This step won’t run until it has a rule. The one below is a suggestion
          until you use it or change it.
        </Notice>
      )}
      <LabelledField id={fieldControlId(form.nodeId, 'kind')} label="Runs">
        {(control) => (
          <ChoiceSelect
            id={control.id}
            value={draft.mode}
            disabled={!form.editable}
            choices={modes.map(({ mode, label }) => ({ value: mode, label }))}
            onChange={(next) => {
              const mode = modes.find((option) => option.mode === next)?.mode;
              if (mode === undefined) return;
              // Switching to a custom rule starts from the one on screen.
              const expression =
                mode === 'custom' ? cronFor(draft) : draft.expression;
              fieldProps.onChange({
                mode,
                expression: expression ?? draft.expression,
              });
            }}
          />
        )}
      </LabelledField>
      <RuleFields {...fieldProps} />
      {draft.mode === 'every' ? null : <TimezoneField {...fieldProps} />}
      <SchedulePreview recurrence={recurrence} />
      {schema.misfire === undefined ? null : (
        <MisfireField
          draft={draft}
          misfire={schema.misfire}
          disabled={!form.editable}
          onChange={fieldProps.onChange}
        />
      )}
    </div>
  );
}

function RuleFields(props: RuleFieldProps) {
  switch (props.draft.mode) {
    case 'every':
      return <EveryField {...props} />;
    case 'custom':
      return <CronField {...props} />;
    case 'weekly':
      return (
        <>
          <DaysField {...props} />
          <TimeField {...props} />
        </>
      );
    case 'daily':
    case 'weekdays':
      return <TimeField {...props} />;
  }
}

/**
 * The rule read back as a sentence, live, with how clock changes apply and
 * the run times the server works out for it.
 */
function SchedulePreview({
  recurrence,
}: Readonly<{ recurrence: ScheduleRecurrence | undefined }>) {
  return (
    <section
      aria-label="When it runs"
      className="rounded-lg border border-white/7 bg-white/[0.025] px-3 py-2.5"
    >
      <p
        aria-live="polite"
        className="font-heading text-base leading-snug font-semibold tracking-[-0.01em]"
      >
        {recurrence === undefined
          ? 'Finish the rule to see when it runs.'
          : describeRecurrence(recurrence)}
      </p>
      {recurrence?.kind === 'cron' ? (
        <p className="mt-0.5 font-mono text-xs text-subtle-foreground">
          {recurrence.timezone.replaceAll('_', ' ')} time
        </p>
      ) : null}
      {recurrence === undefined ? null : (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {describeDaylightSaving(recurrence.kind)}
        </p>
      )}
      <DraftNextRuns recurrence={recurrence} />
    </section>
  );
}
