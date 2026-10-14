import { isRecord } from '@pertexo/workflow-model';
import { schemaFields, type SchemaFieldSpec } from '../draft';
import { describeTransformFields } from './fields';

/** Only Date's catalog union is projected; unknown shapes remain editable as JSON. */
export function dateSetupFields(
  schema: unknown,
  operation: unknown,
):
  | Readonly<{ operation: SchemaFieldSpec; fields: readonly SchemaFieldSpec[] }>
  | undefined {
  if (!isRecord(schema) || !Array.isArray(schema.oneOf)) return undefined;
  const variants = schema.oneOf.filter(isRecord);
  const operations = variants.flatMap((variant) => {
    const properties = variant.properties;
    if (
      !isRecord(properties) ||
      !isRecord(properties.operation) ||
      typeof properties.operation.const !== 'string'
    )
      return [];
    return [{ operation: properties.operation.const, schema: variant }];
  });
  if (operations.length === 0) return undefined;
  const selected = operations.find(
    (variant) => variant.operation === operation,
  );
  const [operationField] = describeTransformFields(
    [
      {
        key: 'operation',
        label: 'Date operation',
        kind: 'string',
        required: true,
        options: operations.map((variant) => variant.operation),
      },
    ],
    'core.date',
  );
  if (operationField === undefined) return undefined;
  return {
    operation: operationField,
    fields: describeTransformFields(
      schemaFields(selected?.schema).filter(
        (field) => field.key !== 'operation',
      ),
      'core.date',
    ),
  };
}
