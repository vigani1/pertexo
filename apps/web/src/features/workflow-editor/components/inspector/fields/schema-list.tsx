import type {
  NodeConfig,
  SchemaFieldSpec,
} from '../../../model/inspector/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { SchemaField } from './schema';

/**
 * Schema fields in order. Fields of one nested object sit together under
 * its name, so "Attempts" reads as part of "Retry".
 */
export function SchemaFieldList({
  fields,
  config,
  form,
  jsonOnlySettings,
}: Readonly<{
  fields: readonly SchemaFieldSpec[];
  config: NodeConfig;
  form: NodeFormApi;
  /** The schema has properties no field models. */
  jsonOnlySettings: boolean;
}>) {
  return (
    <>
      {groupByParent(fields).map((group) =>
        group.parent === undefined ? (
          group.fields.map((field) => (
            <SchemaField
              key={field.key}
              field={field}
              config={config}
              form={form}
            />
          ))
        ) : (
          <fieldset
            key={group.parent.key}
            className="flex min-w-0 flex-col gap-4 border-l-2 border-border pl-3"
          >
            <legend className="mb-3 text-sm font-semibold text-foreground">
              {group.parent.label}
            </legend>
            {group.fields.map((field) => (
              <SchemaField
                key={field.key}
                field={field}
                config={config}
                form={form}
              />
            ))}
          </fieldset>
        ),
      )}
      {jsonOnlySettings ? (
        <p className="text-xs text-subtle-foreground">
          Some settings can only be edited as JSON.
        </p>
      ) : null}
    </>
  );
}

type FieldGroup = Readonly<{
  parent: SchemaFieldSpec['parent'];
  fields: readonly SchemaFieldSpec[];
}>;

function groupByParent(fields: readonly SchemaFieldSpec[]): FieldGroup[] {
  const groups: {
    parent: SchemaFieldSpec['parent'];
    fields: SchemaFieldSpec[];
  }[] = [];
  for (const field of fields) {
    const last = groups.at(-1);
    if (last !== undefined && last.parent?.key === field.parent?.key)
      last.fields.push(field);
    else groups.push({ parent: field.parent, fields: [field] });
  }
  return groups;
}
