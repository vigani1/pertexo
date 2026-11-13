import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/class-names';
import {
  describeAmount,
  toShownValue,
  unitDisplay,
} from '../../../model/field-units';
import {
  fieldPath,
  readFieldValue,
  withFieldValue,
  type FieldParseResult,
  type NodeConfig,
  type SchemaFieldSpec,
} from '../../../model/inspector/draft';
import {
  formatFieldText,
  parseFieldText,
} from '../../../model/inspector/field-text';
import { useInspectorDraftField } from '../use-draft-field';
import { ChoiceSelect } from './choice-select';
import {
  describedBy,
  fieldControlId,
  fieldDescriptionId,
  fieldErrorId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';

type ConfigValue = NodeConfig[string] | undefined;

/** One schema-described setup field that applies valid values as you type. */
export function SchemaField({
  field,
  config,
  form,
}: Readonly<{
  field: SchemaFieldSpec;
  config: NodeConfig;
  form: NodeFormApi;
}>) {
  const path = fieldPath(field);
  const id = fieldControlId(form.nodeId, path);
  const value = readFieldValue(config, field);
  function commit(next: ConfigValue) {
    form.commit(
      (node) => ({ config: withFieldValue(node.config, field, next) }),
      `${form.nodeId}:config:${path}`,
    );
  }
  if (field.kind === 'boolean')
    return (
      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
          <Switch
            id={id}
            aria-describedby={describedBy(id, field.description)}
            checked={value === true}
            disabled={!form.editable}
            onCheckedChange={(checked) => {
              commit(checked);
            }}
          />
        </div>
        <SchemaFieldDescription id={id} text={field.description} />
      </Field>
    );
  if (field.options !== undefined)
    return (
      <Field>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <ChoiceSelect
          value={typeof value === 'string' ? value : null}
          disabled={!form.editable}
          choices={[
            ...(field.required ? [] : [{ value: null, label: 'Not set' }]),
            ...field.options.map((option) => ({
              value: option,
              label: field.optionLabels?.[option] ?? option,
            })),
          ]}
          onChange={(next) => {
            commit(next ?? undefined);
          }}
          control={{
            id,
            describedBy: describedBy(id, field.description),
          }}
        />
        <SchemaFieldDescription id={id} text={field.description} />
      </Field>
    );
  return field.kind === 'string' ? (
    <ConfigTextField
      field={field}
      id={id}
      value={value}
      form={form}
      commit={commit}
    />
  ) : (
    <ConfigNumberField
      field={field}
      id={id}
      value={value}
      form={form}
      commit={commit}
    />
  );
}

type LiveFieldProps = Readonly<{
  field: SchemaFieldSpec;
  id: string;
  value: ConfigValue;
  form: NodeFormApi;
  commit: (value: ConfigValue) => void;
}>;

/** A field's text under live apply, reporting unfinished scratch to the form. */
function useConfigText(
  { field, value, form, commit }: LiveFieldProps,
  format: (value: ConfigValue) => string,
  parse: (text: string) => FieldParseResult<ConfigValue>,
) {
  return useInspectorDraftField<ConfigValue>({
    value,
    format,
    parse,
    commit,
    onScratchChange: (scratch) => {
      form.reportScratch(fieldPath(field), scratch);
    },
  });
}

function ConfigTextField(props: LiveFieldProps) {
  const { field, id, form } = props;
  const path = field.format === 'json-path';
  const live = useConfigText(
    props,
    (current) => formatFieldText(field, current),
    (text) => parseFieldText(field, text),
  );
  const errorId = fieldErrorId(id);
  return (
    <Field data-invalid={live.error !== undefined}>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <Input
        id={id}
        name={`config.${fieldPath(field)}`}
        autoComplete="off"
        className={cn(path && 'font-mono')}
        value={live.text}
        disabled={!form.editable}
        aria-invalid={live.error !== undefined}
        aria-describedby={describedBy(id, field.description, live.error)}
        onChange={(event) => {
          live.change(event.currentTarget.value);
        }}
        onBlur={live.blur}
      />
      <SchemaFieldDescription id={id} text={field.description} />
      {live.error === undefined ? null : (
        <FieldError id={errorId}>{live.error}</FieldError>
      )}
    </Field>
  );
}

/**
 * A number setting, typed in its shown unit: a millisecond timeout reads in
 * seconds, with the unit beside the value and its bounds in words under it.
 * The stepper moves one shown unit at a time.
 */
function ConfigNumberField(props: LiveFieldProps) {
  const { field, id, form, value } = props;
  const live = useConfigText(
    props,
    (current) => formatFieldText(field, current),
    (text) => parseFieldText(field, text),
  );
  const errorId = fieldErrorId(id);
  const unit =
    field.unit === undefined
      ? undefined
      : unitDisplay(field.unit, field.maximum);
  const hint =
    field.description ??
    unitHint(field, typeof value === 'number' ? value : undefined);
  function nudge(direction: 1 | -1) {
    const current = Number(live.text);
    const base =
      live.text.trim() === '' || !Number.isFinite(current) ? 0 : current;
    const shownBound = (bound: number | undefined, fallback: number) =>
      bound === undefined
        ? fallback
        : toShownValue(bound, field.unit, field.maximum);
    const bounded = Math.min(
      shownBound(field.maximum, Number.POSITIVE_INFINITY),
      Math.max(
        shownBound(field.minimum, Number.NEGATIVE_INFINITY),
        base + direction,
      ),
    );
    live.change(String(bounded));
  }
  const isNonnegativeInteger =
    field.kind === 'integer' &&
    field.unit === undefined &&
    field.minimum !== undefined &&
    field.minimum >= 0;
  return (
    <Field data-invalid={live.error !== undefined}>
      <FieldLabel htmlFor={id}>
        {field.label}
        {unit === undefined ? null : (
          <span className="sr-only">{` (in ${unit.name})`}</span>
        )}
      </FieldLabel>
      <div className="flex items-center gap-1.5">
        <FieldControl className="flex-1">
          <Input
            id={id}
            name={`config.${fieldPath(field)}`}
            autoComplete="off"
            // The digit pad has no minus or "." key on every phone, so only
            // whole counts from 0 in their own unit get it.
            inputMode={isNonnegativeInteger ? 'numeric' : undefined}
            className={cn('font-mono', unitPadding(unit))}
            value={live.text}
            disabled={!form.editable}
            aria-invalid={live.error !== undefined}
            aria-describedby={describedBy(id, hint, live.error)}
            onChange={(event) => {
              live.change(event.currentTarget.value);
            }}
            onBlur={live.blur}
          />
          {unit === undefined ? null : (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-xs text-subtle-foreground"
            >
              {unit.symbol}
            </span>
          )}
        </FieldControl>
        <Button
          type="button"
          // The field's own height, so the row reads as one control.
          size="icon"
          variant="outline"
          aria-label={`Decrease ${field.label}`}
          disabled={!form.editable}
          onClick={() => {
            nudge(-1);
          }}
        >
          <MinusIcon />
        </Button>
        <Button
          type="button"
          // The field's own height, so the row reads as one control.
          size="icon"
          variant="outline"
          aria-label={`Increase ${field.label}`}
          disabled={!form.editable}
          onClick={() => {
            nudge(1);
          }}
        >
          <PlusIcon />
        </Button>
      </div>
      <SchemaFieldDescription id={id} text={hint} />
      {live.error === undefined ? null : (
        <FieldError id={errorId}>{live.error}</FieldError>
      )}
    </Field>
  );
}

/**
 * Bounds in words, with a seconds value repeated only when larger time
 * units add meaning. Byte fields already show the size in human units.
 */
function unitHint(
  field: SchemaFieldSpec,
  value: number | undefined,
): string | undefined {
  if (field.unit === undefined) return undefined;
  const parts: string[] = [];
  if (value !== undefined && field.unit === 'seconds') {
    const words = describeAmount(value, field.unit);
    if (words !== `${String(value)} s`) parts.push(`That’s ${words}.`);
  }
  if (field.maximum !== undefined)
    parts.push(`Up to ${describeAmount(field.maximum, field.unit)}.`);
  return parts.length === 0 ? undefined : parts.join(' ');
}

function unitPadding(
  unit: ReturnType<typeof unitDisplay> | undefined,
): string | undefined {
  if (unit === undefined) return undefined;
  return unit.symbol === 's' ? 'pr-7' : 'pr-14';
}

/** A field's help, under the id `describedBy` names. */
export function SchemaFieldDescription({
  id,
  text,
}: Readonly<{ id: string; text: string | undefined }>) {
  return text === undefined ? null : (
    <FieldDescription id={fieldDescriptionId(id)}>{text}</FieldDescription>
  );
}
