import { useScratchForm } from '../use-draft-field';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { operationSetupFields } from '../../../model/inspector/transforms/operation-fields';
import { utilityOperationConfig } from '../../../model/inspector/transforms/utility-config';
import type { NodeConfig } from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { ChoiceSelect } from '../fields/choice-select';
import { SchemaField } from '../fields/schema';

const help: Readonly<Record<string, string>> = {
  'core.xml':
    'Convert data, not document formatting. XML attributes use @_ and text uses #text. DTDs are not supported.',
  'core.html':
    'Extract text or an attribute with a simple CSS selector. Scripts never run and links are never fetched. Match count and Truncated show when your result limit was reached.',
  'core.crypto':
    'MD5 is not for security. UUID and random IDs change whenever this step runs again.',
  'core.text':
    'Map text in Inputs. Replace uses Search and Replacement; Split uses Delimiter. Matches are literal, never regex.',
  'core.number':
    'Map a number in Inputs. Percent formats 0.25 as 25%. Currency formats the value without converting it.',
};
export function UtilitySetup({
  definitionKey,
  schema,
  config,
  form,
}: Readonly<{
  definitionKey: string;
  schema: unknown;
  config: NodeConfig;
  form: NodeFormApi;
}>) {
  const { form: trackedForm, hasScratch } = useScratchForm(form);
  const fields = operationSetupFields(schema, config.operation, definitionKey);
  if (fields === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        Use Edit as JSON for this utility’s settings.
      </p>
    );
  const id = fieldControlId(form.nodeId, 'operation');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>Operation</FieldLabel>
        <ChoiceSelect
          value={typeof config.operation === 'string' ? config.operation : null}
          disabled={!form.editable || hasScratch}
          choices={(fields.operation.options ?? []).map((value) => ({
            value,
            label: fields.operation.optionLabels?.[value] ?? value,
          }))}
          onChange={(operation) => {
            if (operation === null) return;
            const next = utilityOperationConfig(definitionKey, operation);
            if (next !== undefined)
              form.commit(
                { config: next },
                `${form.nodeId}:config:operation:${operation}`,
              );
          }}
          control={{ id: id }}
        />
        <FieldDescription>{help[definitionKey]}</FieldDescription>
      </Field>
      {fields.fields.map((field) => (
        <SchemaField
          key={field.key}
          field={field}
          config={config}
          form={trackedForm}
        />
      ))}
    </>
  );
}
