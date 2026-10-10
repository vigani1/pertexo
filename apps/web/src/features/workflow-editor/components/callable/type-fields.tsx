import { useId } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import { emptyType, type TypeDraft } from '../../forms/callable/type-draft';
import { ChoiceSelect } from '../inspector/fields/choice-select';

const TYPE_CHOICES = [
  { value: 'object', label: 'Object' },
  { value: 'array', label: 'Array' },
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'null', label: 'Null' },
] as const;

type TypeFieldProps = Readonly<{
  value: TypeDraft;
  onChange: (value: TypeDraft) => void;
  depth?: number;
  path: string;
  validation: FieldValidation<string>;
}>;
type ObjectProperty = Extract<
  TypeDraft,
  { type: 'object' }
>['properties'][number];

export function TypeFields({
  value,
  onChange,
  depth = 1,
  path,
  validation,
}: TypeFieldProps) {
  const id = useId();
  const typeField = `${path}.type`;
  const limitField = `${path}.maxItems`;
  return (
    <FieldGroup className="gap-3">
      <LabelledField
        id={`${id}-type`}
        label="Value type"
        error={validation.error(typeField)}
      >
        {(control) => (
          <ChoiceSelect
            id={control.id}
            value={value.type}
            choices={
              depth >= 64
                ? TYPE_CHOICES.filter(({ value: kind }) => kind !== 'array')
                : TYPE_CHOICES
            }
            disabled={false}
            name={typeField}
            ref={validation.register(typeField)}
            invalid={control['aria-invalid']}
            describedBy={control['aria-describedby']}
            onChange={(next) => {
              const choice = TYPE_CHOICES.find((entry) => entry.value === next);
              if (choice !== undefined && choice.value !== value.type)
                onChange(emptyType(choice.value));
            }}
          />
        )}
      </LabelledField>
      {value.type === 'array' ? (
        <>
          <LabelledField
            id={`${id}-max`}
            label="Maximum items"
            error={validation.error(limitField)}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0}
                max={10_000}
                step={1}
                name={limitField}
                autoComplete="off"
                ref={validation.register(limitField)}
                value={value.maxItems}
                onChange={(event) => {
                  onChange({ ...value, maxItems: event.target.value });
                }}
              />
            )}
          </LabelledField>
          <fieldset className="flex min-w-0 flex-col gap-3 border-l border-border pl-3">
            <legend className="mb-2 text-sm font-semibold">Array item</legend>
            <TypeFields
              value={value.items}
              path={`${path}.items`}
              validation={validation}
              depth={depth + 1}
              onChange={(items) => {
                onChange({ ...value, items });
              }}
            />
          </fieldset>
        </>
      ) : null}
      {value.type === 'object' ? (
        <>
          {value.properties.map((property, index) => (
            <PropertyFields
              key={property.id}
              property={property}
              path={`${path}.properties.${String(index)}`}
              validation={validation}
              depth={depth + 1}
              onChange={(next) => {
                onChange({
                  ...value,
                  properties: value.properties.map((entry) =>
                    entry.id === property.id ? next : entry,
                  ),
                });
              }}
              onRemove={() => {
                onChange({
                  ...value,
                  properties: value.properties.filter(
                    (entry) => entry.id !== property.id,
                  ),
                });
              }}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            disabled={depth >= 64 || value.properties.length >= 10_000}
            onClick={() => {
              onChange({
                ...value,
                properties: [
                  ...value.properties,
                  {
                    id: crypto.randomUUID(),
                    name: '',
                    required: true,
                    valueType: { type: 'string' },
                  },
                ],
              });
            }}
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add property
          </Button>
          <p className="text-xs text-muted-foreground">
            Extra properties are rejected.
          </p>
        </>
      ) : null}
    </FieldGroup>
  );
}

function PropertyFields({
  property,
  path,
  validation,
  depth,
  onChange,
  onRemove,
}: Readonly<{
  property: ObjectProperty;
  path: string;
  validation: FieldValidation<string>;
  depth: number;
  onChange: (property: ObjectProperty) => void;
  onRemove: () => void;
}>) {
  const nameField = `${path}.name`;
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 border-l border-border pl-3 [contain-intrinsic-size:auto_14rem] [content-visibility:auto]">
      <legend className="mb-2 text-sm font-semibold break-words">
        {property.name || 'New property'}
      </legend>
      <LabelledField
        id={`${property.id}-name`}
        label="Property name"
        error={validation.error(nameField)}
      >
        {(control) => (
          <div className="flex items-center gap-2">
            <Input
              {...control}
              maxLength={64}
              value={property.name}
              autoComplete="off"
              spellCheck={false}
              name={nameField}
              ref={validation.register(nameField)}
              onChange={(event) => {
                onChange({ ...property, name: event.target.value });
              }}
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${property.name || 'new property'}`}
              onClick={onRemove}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </div>
        )}
      </LabelledField>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={property.required}
          onCheckedChange={(required) => {
            onChange({ ...property, required });
          }}
        />
        Required
      </label>
      <TypeFields
        value={property.valueType}
        path={`${path}.valueType`}
        validation={validation}
        depth={depth}
        onChange={(valueType) => {
          onChange({ ...property, valueType });
        }}
      />
    </fieldset>
  );
}
