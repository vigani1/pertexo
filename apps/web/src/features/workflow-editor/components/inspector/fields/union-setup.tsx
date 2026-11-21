import { Field, FieldLabel } from '@/components/ui/field';
import {
  coveredProperties,
  type NodeConfig,
} from '../../../model/inspector/draft';
import {
  describedBy,
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import {
  unionFields,
  unionPropertyCount,
  withUnionChoice,
  type SchemaUnion,
} from '../../../model/inspector/schema-union';
import { useScratchForm } from '../use-draft-field';
import { ChoiceSelect } from './choice-select';
import { SchemaFieldList } from './schema-list';
import { ModelOutputSchema } from './model-output-schema';
import { SchemaFieldDescription } from './schema';

/**
 * Setup that takes one of several shapes (Date's operation, say): a choice
 * from the schema's labelled `const`s, then the chosen shape's fields.
 * Choosing again keeps the values both shapes share, in one undoable edit.
 */
export function SchemaUnionSetup({
  union,
  config,
  model = false,
  form: parentForm,
}: Readonly<{
  union: SchemaUnion;
  config: NodeConfig;
  model?: boolean;
  form: NodeFormApi;
}>) {
  const { form, hasScratch } = useScratchForm(parentForm);
  const choice = config[union.key];
  const modelOutputSchema = model && choice === 'structured';
  const fields = unionFields(union, choice).map((field) =>
    model && field.key === 'model'
      ? {
          ...field,
          description: 'Required. Use the model identifier from your provider.',
        }
      : field,
  );
  const id = fieldControlId(form.nodeId, union.key);
  const hint = hasScratch
    ? `Fix the unfinished edit before choosing another ${union.label.toLowerCase()}.`
    : union.description;
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>{union.label}</FieldLabel>
        <ChoiceSelect
          value={typeof choice === 'string' ? choice : null}
          disabled={!form.editable || hasScratch}
          choices={union.choices}
          onChange={(next) => {
            if (next === null || next === choice) return;
            form.commit(
              (node) => ({
                config:
                  withUnionChoice(union, node.config, next) ?? node.config,
              }),
              `${form.nodeId}:config:${union.key}:${next}`,
            );
          }}
          control={{ id, describedBy: describedBy(id, hint) }}
        />
        <SchemaFieldDescription id={id} text={hint} />
      </Field>
      <SchemaFieldList
        fields={fields}
        config={config}
        form={form}
        jsonOnlySettings={
          unionPropertyCount(union, choice) >
          coveredProperties(fields) + Number(modelOutputSchema)
        }
      />
      {modelOutputSchema ? (
        <ModelOutputSchema config={config} form={form} />
      ) : null}
    </>
  );
}
