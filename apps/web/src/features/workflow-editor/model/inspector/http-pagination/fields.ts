import { isRecord } from '@pertexo/workflow-model';
import { schemaFields, type SchemaFieldSpec, type NodeConfig } from '../draft';

function property(schema: unknown, key: string): unknown {
  return isRecord(schema) && isRecord(schema.properties)
    ? schema.properties[key]
    : undefined;
}
function variant(schema: unknown, key: string, value: unknown): unknown {
  if (!isRecord(schema)) return undefined;
  const shapes = schema.oneOf ?? schema.anyOf;
  return Array.isArray(shapes)
    ? (shapes as unknown[]).find((shape) => {
        const candidate = property(shape, key);
        return isRecord(candidate) && candidate.const === value;
      })
    : undefined;
}
export function paginationFields(
  schema: unknown,
  mode: unknown,
  source: unknown,
) {
  const selected = variant(property(schema, 'pagination'), 'mode', mode);
  return {
    common: schemaFields(selected).filter(
      ({ key }) => key !== 'mode' && key !== 'source',
    ),
    source: schemaFields(
      variant(property(selected, 'source'), 'kind', source),
    ).filter(({ key }) => key !== 'kind'),
  };
}

export function httpSetupFields(
  fields: readonly SchemaFieldSpec[],
  config: NodeConfig,
): readonly SchemaFieldSpec[] {
  if (config.pagination === undefined) return fields;
  return fields.map((field) =>
    field.key === 'inlineResponseBytes'
      ? {
          ...field,
          label: 'Largest page',
          description:
            'Pages stay inline and must fit this limit. Larger pages fail.',
        }
      : field,
  );
}
