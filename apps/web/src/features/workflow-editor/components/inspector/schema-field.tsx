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
import {
  parseNumberField,
  withConfigValue,
  type NodeConfig,
  type SchemaFieldSpec,
} from '../../model/inspector-draft';
import { useLiveField } from '../../model/use-live-field';
import { ChoiceSelect } from './choice-select';
import { fieldControlId, type NodeFormApi } from './node-form';

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
  const id = fieldControlId(form.nodeId, field.key);
  const value = config[field.key];
  function commit(next: ConfigValue) {
    form.commit(
      (node) => ({ config: withConfigValue(node.config, field.key, next) }),
      `${form.nodeId}:config:${field.key}`,
    );
  }
  if (field.kind === 'boolean')
    return (
      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
          <Switch
            id={id}
            checked={value === true}
            disabled={!form.editable}
            onCheckedChange={(checked) => {
              commit(checked);
            }}
          />
        </div>
        {field.description === undefined ? null : (
          <FieldDescription>{field.description}</FieldDescription>
        )}
      </Field>
    );
  if (field.options !== undefined)
    return (
      <Field>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <ChoiceSelect
          id={id}
          value={typeof value === 'string' ? value : null}
          disabled={!form.editable}
          choices={[
            ...(field.required ? [] : [{ value: null, label: 'Not set' }]),
            ...field.options.map((option) => ({
              value: option,
              label: option,
            })),
          ]}
          onChange={(next) => {
            commit(next ?? undefined);
          }}
        />
        {field.description === undefined ? null : (
          <FieldDescription>{field.description}</FieldDescription>
        )}
      </Field>
    );
  return field.kind === 'string' ? (
    <TextField
      field={field}
      id={id}
      value={value}
      form={form}
      commit={commit}
    />
  ) : (
    <NumberField
      field={field}
      id={id}
      value={value}
      form={form}
      commit={commit}
    />
  );
}

function TextField({
  field,
  id,
  value,
  form,
  commit,
}: Readonly<{
  field: SchemaFieldSpec;
  id: string;
  value: ConfigValue;
  form: NodeFormApi;
  commit: (value: ConfigValue) => void;
}>) {
  const live = useLiveField<ConfigValue>({
    value,
    format: (current) =>
      typeof current === 'string' || typeof current === 'number'
        ? String(current)
        : '',
    parse: (text) => ({
      ok: true,
      value: text === '' && !field.required ? undefined : text,
    }),
    commit,
    onScratchChange: (scratch) => {
      form.reportScratch(field.key, scratch);
    },
  });
  return (
    <Field>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <Input
        id={id}
        name={`config.${field.key}`}
        autoComplete="off"
        value={live.text}
        disabled={!form.editable}
        onChange={(event) => {
          live.change(event.currentTarget.value);
        }}
      />
      {field.description === undefined ? null : (
        <FieldDescription>{field.description}</FieldDescription>
      )}
    </Field>
  );
}

function NumberField({
  field,
  id,
  value,
  form,
  commit,
}: Readonly<{
  field: SchemaFieldSpec;
  id: string;
  value: ConfigValue;
  form: NodeFormApi;
  commit: (value: ConfigValue) => void;
}>) {
  const live = useLiveField<ConfigValue>({
    value,
    format: (current) => (typeof current === 'number' ? String(current) : ''),
    parse: (text) => parseNumberField(field, text),
    commit,
    onScratchChange: (scratch) => {
      form.reportScratch(field.key, scratch);
    },
  });
  const errorId = `${id}-error`;
  function nudge(direction: 1 | -1) {
    const current = Number(live.text);
    const base =
      live.text.trim() === '' || !Number.isFinite(current) ? 0 : current;
    const next = base + direction;
    const bounded = Math.min(
      field.maximum ?? Number.POSITIVE_INFINITY,
      Math.max(field.minimum ?? Number.NEGATIVE_INFINITY, next),
    );
    live.change(String(bounded));
  }
  return (
    <Field data-invalid={live.error !== undefined}>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <div className="flex items-center gap-1.5">
        <FieldControl
          state={live.error === undefined ? undefined : 'invalid'}
          className="flex-1"
        >
          <Input
            id={id}
            name={`config.${field.key}`}
            autoComplete="off"
            inputMode="decimal"
            className="font-mono"
            value={live.text}
            disabled={!form.editable}
            aria-invalid={live.error !== undefined}
            aria-describedby={live.error === undefined ? undefined : errorId}
            onChange={(event) => {
              live.change(event.currentTarget.value);
            }}
          />
        </FieldControl>
        <Button
          type="button"
          size="icon-sm"
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
          size="icon-sm"
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
      {field.description === undefined ? null : (
        <FieldDescription>{field.description}</FieldDescription>
      )}
      {live.error === undefined ? null : (
        <FieldError id={errorId}>{live.error}</FieldError>
      )}
    </Field>
  );
}
