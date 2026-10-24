import type { FormField } from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { LabelledField } from '@/components/ui/field';

const fieldTypes: readonly Readonly<{
  value: FormField['type'];
  label: string;
}>[] = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'email', label: 'Email' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'True or false' },
  { value: 'select', label: 'Choose one' },
  { value: 'multi_select', label: 'Choose multiple' },
  { value: 'date', label: 'Date' },
];

export function FormFieldCard({
  field,
  id,
  index,
  count,
  disabled,
  onMove,
  onRemove,
  onUpdate,
}: Readonly<{
  field: FormField;
  id: string;
  index: number;
  count: number;
  disabled: boolean;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onUpdate: FieldUpdate;
}>) {
  return (
    <section
      aria-label={`Field ${String(index + 1)}`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
    >
      <FieldOrderActions
        index={index}
        count={count}
        disabled={disabled}
        onMove={onMove}
        onRemove={onRemove}
      />
      <LabelledField id={`${id}-${field.id}-label`} label="Label">
        {(control) => (
          <Input
            {...control}
            value={field.label}
            maxLength={160}
            onChange={(event) => {
              onUpdate((current) => ({
                ...current,
                label: event.target.value,
              }));
            }}
          />
        )}
      </LabelledField>
      <LabelledField
        id={`${id}-${field.id}-name`}
        label="Data name"
        description="Use letters, digits and underscores. Later steps read this name."
      >
        {(control) => (
          <Input
            {...control}
            value={field.name}
            maxLength={64}
            onChange={(event) => {
              onUpdate((current) => ({
                ...current,
                name: event.target.value,
              }));
            }}
          />
        )}
      </LabelledField>
      <FieldTypeControl field={field} id={id} onUpdate={onUpdate} />
      <LabelledField id={`${id}-${field.id}-help`} label="Help text (optional)">
        {(control) => (
          <Input
            {...control}
            value={field.help}
            maxLength={500}
            onChange={(event) => {
              onUpdate((current) => ({
                ...current,
                help: event.target.value,
              }));
            }}
          />
        )}
      </LabelledField>
      <FieldChoices field={field} id={id} onUpdate={onUpdate} />

      <LabelledField id={`${id}-${field.id}-required`} label="Required">
        {(control) => (
          <Checkbox
            {...control}
            checked={field.required}
            onCheckedChange={(required) => {
              onUpdate((current) => ({ ...current, required }));
            }}
          />
        )}
      </LabelledField>
      {field.type === 'boolean' ? (
        <LabelledField
          id={`${id}-${field.id}-ticked`}
          label="Must be ticked to send"
          description="For an agreement such as terms of service. Leave it off for a yes/no question."
        >
          {(control) => (
            <Checkbox
              {...control}
              checked={field.mustBeTicked ?? false}
              onCheckedChange={(ticked) => {
                onUpdate((current) => {
                  if (current.type !== 'boolean') return current;
                  const { mustBeTicked: _previous, ...rest } = current;
                  return ticked ? { ...rest, mustBeTicked: true } : rest;
                });
              }}
            />
          )}
        </LabelledField>
      ) : null}
    </section>
  );
}

type FieldUpdate = (change: (current: FormField) => FormField) => void;

function FieldOrderActions({
  index,
  count,
  disabled,
  onMove,
  onRemove,
}: Readonly<{
  index: number;
  count: number;
  disabled: boolean;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">Field {index + 1}</span>
      <div className="flex gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || index === 0}
          onClick={() => {
            onMove(-1);
          }}
          aria-label={`Move field ${String(index + 1)} up`}
        >
          Up
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || index === count - 1}
          onClick={() => {
            onMove(1);
          }}
          aria-label={`Move field ${String(index + 1)} down`}
        >
          Down
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || count === 1}
          onClick={() => {
            onRemove();
          }}
          aria-label={`Remove field ${String(index + 1)}`}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

function FieldTypeControl({
  field,
  id,
  onUpdate,
}: Readonly<{ field: FormField; id: string; onUpdate: FieldUpdate }>) {
  return (
    <LabelledField id={`${id}-${field.id}-type`} label="Type">
      {(control) => (
        <select
          {...control}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-ring md:text-sm"
          value={field.type}
          onChange={(event) => {
            onUpdate((current) => {
              const type = event.target.value as FormField['type'];
              const base = {
                id: current.id,
                name: current.name,
                label: current.label,
                help: current.help,
                required: current.required,
              };
              return type === 'select' || type === 'multi_select'
                ? {
                    ...base,
                    type,
                    options:
                      current.type === 'select' ||
                      current.type === 'multi_select'
                        ? current.options
                        : ['Option 1'],
                  }
                : { ...base, type };
            });
          }}
        >
          {fieldTypes.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      )}
    </LabelledField>
  );
}

function FieldChoices({
  field,
  id,
  onUpdate,
}: Readonly<{ field: FormField; id: string; onUpdate: FieldUpdate }>) {
  return (
    <>
      {field.type === 'select' || field.type === 'multi_select' ? (
        <LabelledField
          id={`${id}-${field.id}-options`}
          label="Options"
          description="One option per line, up to 50."
        >
          {(control) => (
            <Textarea
              {...control}
              value={field.options.join('\n')}
              rows={3}
              onChange={(event) => {
                onUpdate((current) => ({
                  ...current,
                  type: field.type,
                  options: event.target.value.split('\n'),
                }));
              }}
            />
          )}
        </LabelledField>
      ) : null}
      {field.type === 'multi_select' ? (
        <div className="grid grid-cols-2 gap-3">
          {(['minSelections', 'maxSelections'] as const).map((key) => (
            <LabelledField
              key={key}
              id={`${id}-${field.id}-${key}`}
              label={
                key === 'minSelections'
                  ? 'Minimum selections'
                  : 'Maximum selections'
              }
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={key === 'minSelections' ? 0 : 1}
                  max={field.options.length}
                  value={field[key] ?? ''}
                  placeholder={selectionPlaceholder(field, key)}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    onUpdate((current) => {
                      const copy = { ...current };
                      if (text === '') {
                        Reflect.deleteProperty(copy, key);
                        return copy;
                      }
                      return { ...copy, [key]: Number(text) };
                    });
                  }}
                />
              )}
            </LabelledField>
          ))}
        </div>
      ) : null}
    </>
  );
}

function selectionPlaceholder(
  field: Extract<FormField, { type: 'multi_select' }>,
  key: 'minSelections' | 'maxSelections',
): string {
  if (key === 'maxSelections') return String(field.options.length);
  return field.required ? '1' : '0';
}
