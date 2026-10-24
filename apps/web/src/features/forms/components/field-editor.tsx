import { useId } from 'react';
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
export function FormFieldsEditor({
  fields,
  onChange,
  disabled = false,
}: Readonly<{
  fields: readonly FormField[];
  onChange: (fields: readonly FormField[]) => void;
  disabled?: boolean;
}>) {
  const id = useId();
  function update(index: number, change: (field: FormField) => FormField) {
    onChange(fields.map((field, i) => (i === index ? change(field) : field)));
  }
  function move(index: number, direction: -1 | 1) {
    const next = [...fields];
    const current = next[index],
      other = next[index + direction];
    if (current === undefined || other === undefined) return;
    next[index] = other;
    next[index + direction] = current;
    onChange(next);
  }
  function add() {
    const names = new Set(fields.map((field) => field.name));
    let index = fields.length + 1;
    while (names.has(`field_${String(index)}`)) index++;
    onChange([
      ...fields,
      {
        id: crypto.randomUUID(),
        name: `field_${String(index)}`,
        label: `Field ${String(index)}`,
        type: 'text',
        help: '',
        required: true,
      },
    ]);
  }
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
      <legend className="mb-3 font-medium">Form fields</legend>
      {fields.map((field, index) => (
        <section
          key={field.id}
          aria-label={`Field ${String(index + 1)}`}
          className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Field {index + 1}</span>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || index === 0}
                onClick={() => {
                  move(index, -1);
                }}
                aria-label={`Move field ${String(index + 1)} up`}
              >
                Up
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || index === fields.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
                aria-label={`Move field ${String(index + 1)} down`}
              >
                Down
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || fields.length === 1}
                onClick={() => {
                  onChange(fields.filter((item) => item.id !== field.id));
                }}
                aria-label={`Remove field ${String(index + 1)}`}
              >
                Remove
              </Button>
            </div>
          </div>
          <LabelledField id={`${id}-${field.id}-label`} label="Label">
            {(control) => (
              <Input
                {...control}
                value={field.label}
                maxLength={160}
                onChange={(event) => {
                  update(index, (current) => ({
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
                  update(index, (current) => ({
                    ...current,
                    name: event.target.value,
                  }));
                }}
              />
            )}
          </LabelledField>
          <LabelledField id={`${id}-${field.id}-type`} label="Type">
            {(control) => (
              <select
                {...control}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-ring md:text-sm"
                value={field.type}
                onChange={(event) => {
                  update(index, (current) => {
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
          <LabelledField
            id={`${id}-${field.id}-help`}
            label="Help text (optional)"
          >
            {(control) => (
              <Input
                {...control}
                value={field.help}
                maxLength={500}
                onChange={(event) => {
                  update(index, (current) => ({
                    ...current,
                    help: event.target.value,
                  }));
                }}
              />
            )}
          </LabelledField>
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
                    update(index, (current) => ({
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
                      placeholder={
                        key === 'minSelections'
                          ? field.required
                            ? '1'
                            : '0'
                          : String(field.options.length)
                      }
                      onChange={(event) => {
                        const text = event.currentTarget.value;
                        update(index, (current) => {
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
          <LabelledField id={`${id}-${field.id}-required`} label="Required">
            {(control) => (
              <Checkbox
                {...control}
                checked={field.required}
                onCheckedChange={(required) => {
                  update(index, (current) => ({ ...current, required }));
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
                    update(index, (current) => {
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
      ))}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={disabled || fields.length >= 20}
        onClick={add}
      >
        Add field
      </Button>
      <p className="text-xs text-muted-foreground">
        Up to 20 fields. File uploads are not available.
      </p>
    </fieldset>
  );
}
