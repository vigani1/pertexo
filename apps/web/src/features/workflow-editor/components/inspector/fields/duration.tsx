import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  withConfigValue,
  type FieldParseResult,
  type NodeConfig,
} from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { ChoiceSelect } from '../fields/choice-select';
import { useInspectorDraftField } from '../use-draft-field';

const UNITS = [
  { value: 'days', label: 'days', seconds: 86_400 },
  { value: 'hours', label: 'hours', seconds: 3_600 },
  { value: 'minutes', label: 'minutes', seconds: 60 },
  { value: 'seconds', label: 'seconds', seconds: 1 },
] as const;
type Unit = (typeof UNITS)[number]['value'];
type DurationText = Readonly<{ amount: string; unit: Unit }>;

/** The largest unit the stored seconds fill exactly: 7200 → 2 hours. */
function splitSeconds(seconds: unknown): DurationText {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1)
    return { amount: '', unit: 'minutes' };
  const unit =
    UNITS.find((choice) => seconds % choice.seconds === 0) ?? UNITS[3];
  return { amount: String(seconds / unit.seconds), unit: unit.value };
}

/**
 * A duration as people say it, an amount and a unit, kept as whole seconds
 * in the step. Changing the unit keeps the amount: 2 hours becomes 2 days.
 */
export function DurationField({
  config,
  form,
  configKey,
  label,
  description,
  maximumSeconds,
}: Readonly<{
  config: NodeConfig;
  form: NodeFormApi;
  configKey: 'durationSeconds' | 'timeoutSeconds';
  label: string;
  description: string;
  maximumSeconds: number;
}>) {
  const id = fieldControlId(form.nodeId, configKey);
  const errorId = `${id}-error`;
  const live = useInspectorDraftField<unknown, DurationText>({
    value: config[configKey],
    format: splitSeconds,
    equals: (left, right) => left === right,
    parse: (text): FieldParseResult<unknown> => {
      const amount = Number(text.amount);
      if (text.amount.trim() === '' || !Number.isInteger(amount) || amount < 1)
        return { ok: false, error: 'Enter a whole number, 1 or more.' };
      const unit = UNITS.find((choice) => choice.value === text.unit);
      const seconds = amount * (unit?.seconds ?? 1);
      if (seconds > maximumSeconds)
        return { ok: false, error: 'Use 30 days or less.' };
      return { ok: true, value: seconds };
    },
    commit: (seconds) => {
      if (typeof seconds !== 'number') return;
      form.commit(
        (node) => ({
          config: withConfigValue(node.config, configKey, seconds),
        }),
        `${form.nodeId}:config:${configKey}`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch(configKey, scratch);
    },
  });
  return (
    <Field data-invalid={live.error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          name={`config.${configKey}`}
          autoComplete="off"
          inputMode="numeric"
          className="w-24 font-mono"
          value={live.text.amount}
          disabled={!form.editable}
          aria-invalid={live.error !== undefined}
          aria-describedby={live.error === undefined ? undefined : errorId}
          onChange={(event) => {
            live.change({ ...live.text, amount: event.currentTarget.value });
          }}
          onBlur={live.blur}
        />
        <div className="min-w-0 flex-1">
          <ChoiceSelect
            value={live.text.unit}
            disabled={!form.editable}
            choices={UNITS.map(({ value, label: name }) => ({
              value,
              label: name,
            }))}
            onChange={(unit) => {
              const chosen = UNITS.find((choice) => choice.value === unit);
              if (chosen !== undefined)
                live.change({ ...live.text, unit: chosen.value });
            }}
            control={{ id: `${id}-unit`, label: `${label} unit` }}
          />
        </div>
      </div>
      {live.error === undefined ? (
        <FieldDescription>{description}</FieldDescription>
      ) : (
        <FieldError id={errorId}>{live.error}</FieldError>
      )}
    </Field>
  );
}
