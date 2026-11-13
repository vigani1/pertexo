import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  coveredProperties,
  type NodeConfig,
} from '../../../model/inspector/draft';
import {
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

/**
 * Setup that takes one of several shapes (Date's operation, say): a choice
 * from the schema's labelled `const`s, then the chosen shape's fields.
 * Choosing again keeps the values both shapes share, in one undoable edit.
 */
export function SchemaUnionSetup({
  union,
  config,
  form: parentForm,
}: Readonly<{ union: SchemaUnion; config: NodeConfig; form: NodeFormApi }>) {
  const { form, hasScratch } = useScratchForm(parentForm);
  const choice = config[union.key];
  const fields = unionFields(union, choice);
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
          control={{ id }}
        />
        {hint === undefined ? null : (
          <FieldDescription>{hint}</FieldDescription>
        )}
      </Field>
      <SchemaFieldList
        fields={fields}
        config={config}
        form={form}
        jsonOnlySettings={
          unionPropertyCount(union, choice) > coveredProperties(fields)
        }
      />
    </>
  );
}
