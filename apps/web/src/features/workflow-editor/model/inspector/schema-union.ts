import { isRecord, type SchemaUnion } from '@pertexo/workflow-model';
import { schemaFields, type SchemaFieldSpec } from './draft';

/** The fields of the chosen shape, without the choice itself. */
export function unionFields(
  union: SchemaUnion,
  choice: unknown,
): readonly SchemaFieldSpec[] {
  const variant =
    typeof choice === 'string' ? union.variants.get(choice) : undefined;
  return schemaFields(variant).filter((field) => field.key !== union.key);
}

/** How many settings the chosen shape has, besides the choice. */
export function unionPropertyCount(
  union: SchemaUnion,
  choice: unknown,
): number {
  const variant =
    typeof choice === 'string' ? union.variants.get(choice) : undefined;
  const properties = isRecord(variant) ? variant.properties : undefined;
  return isRecord(properties)
    ? Object.keys(properties).filter((key) => key !== union.key).length
    : 0;
}
