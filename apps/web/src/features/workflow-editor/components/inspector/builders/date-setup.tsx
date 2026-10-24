import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { dateOperationConfig } from '../../../model/graph/starting-config';
import { operationSetupFields } from '../../../model/inspector/transforms/operation-fields';
import type { NodeConfig } from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { ChoiceSelect } from '../fields/choice-select';
import { SchemaField } from '../fields/schema-field';

export function DateSetup({
  schema,
  config,
  form,
}: Readonly<{ schema: unknown; config: NodeConfig; form: NodeFormApi }>) {
  const fields = operationSetupFields(schema, config.operation);
  if (fields === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        Use Edit as JSON to configure this Date step.
      </p>
    );
  const id = fieldControlId(form.nodeId, 'operation');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>{fields.operation.label}</FieldLabel>
        <ChoiceSelect
          value={typeof config.operation === 'string' ? config.operation : null}
          disabled={!form.editable}
          choices={(fields.operation.options ?? []).map((value) => ({
            value,
            label: fields.operation.optionLabels?.[value] ?? value,
          }))}
          onChange={(operation) => {
            if (operation === null) return;
            const next = dateOperationConfig(operation);
            if (next !== undefined)
              form.commit(
                { config: next },
                `${form.nodeId}:config:operation:${operation}`,
              );
          }}
          control={{ id: id }}
        />
        <FieldDescription>
          Use a date like 2026-10-19, a time with its offset like
          2026-10-19T09:30:00+02:00, or epoch milliseconds. A new operation
          starts with its own settings; Undo restores the previous setup.
        </FieldDescription>
      </Field>
      {fields.fields.map((field) => (
        <SchemaField
          key={field.key}
          field={field}
          config={config}
          form={form}
        />
      ))}
    </>
  );
}
