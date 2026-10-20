import { isRecord } from '@pertexo/workflow-model';
import { schemaFields, type SchemaFieldSpec } from '../draft';
import { describeTransformFields } from './fields';

/** Project a catalog operation union; unknown shapes remain editable as JSON. */
export function operationSetupFields(
  schema: unknown,
  operation: unknown,
  definitionKey = 'core.date',
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
        label: definitionKey === 'core.date' ? 'Date operation' : 'Operation',
        kind: 'string',
        required: true,
        options: operations.map((variant) => variant.operation),
      },
    ],
    definitionKey,
  );
  if (operationField === undefined) return undefined;
  return {
    operation: operationField,
    fields: describeTransformFields(
      schemaFields(selected?.schema).filter(
        (field) => field.key !== 'operation',
      ),
      definitionKey,
    ),
  };
}
