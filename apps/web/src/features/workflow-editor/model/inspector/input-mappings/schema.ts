import {
  selectOutputVariant,
  type OutputVariantSelection,
} from '@pertexo/node-sdk';
import { isRecord } from '@pertexo/workflow-model';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import type { WorkflowNode } from '../../graph/scopes';

export type SchemaValueType =
  'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export type InputKeySuggestion = Readonly<{
  key: string;
  label: string;
  description?: string;
  type?: SchemaValueType;
}>;

export function inputKeySuggestions(
  inputSchema: NodeDefinitionCatalogItem['inputSchema'] | undefined,
): readonly InputKeySuggestion[] {
  return schemaProperties(inputSchema).map(([key, candidate]) => {
    if (!isRecord(candidate)) return { key, label: key };
    const title = Reflect.get(candidate, 'title');
    const description = Reflect.get(candidate, 'description');
    const type = schemaValueType(candidate);
    return {
      key,
      label: typeof title === 'string' ? title : key,
      ...(typeof description === 'string' ? { description } : {}),
      ...(type === undefined ? {} : { type }),
    };
  });
}

export type OutputField = Readonly<{ key: string; type?: SchemaValueType }>;

function selectedOutputSchema(
  outputSchema: unknown,
  node?: Pick<WorkflowNode, 'config'>,
  outputVariant?: OutputVariantSelection,
): unknown {
  if (
    node === undefined ||
    outputVariant === undefined ||
    !isRecord(outputSchema)
  )
    return outputSchema;
  const variants = outputSchema.anyOf ?? outputSchema.oneOf;
  return Array.isArray(variants)
    ? variants[selectOutputVariant(outputVariant, node.config)]
    : outputSchema;
}

/** Top-level output fields, including alternatives, for "Insert data". */
export function outputFieldsOf(
  outputSchema: unknown,
  node?: Pick<WorkflowNode, 'config'>,
  outputVariant?: OutputVariantSelection,
): readonly OutputField[] {
  const schema = selectedOutputSchema(outputSchema, node, outputVariant);
  return schemaProperties(schema).map(([key, candidate]) => {
    const type = isRecord(candidate) ? schemaValueType(candidate) : undefined;
    return type === undefined ? { key } : { key, type };
  });
}

export type FileField = Readonly<{
  key: string;
  /** Some outputs are a file only sometimes, such as an HTTP response body. */
  sometimes: boolean;
}>;

function isFileReferenceSchema(candidate: unknown): boolean {
  if (!isRecord(candidate) || !isRecord(candidate.properties)) return false;
  const kind = candidate.properties.kind;
  return isRecord(kind) && kind.const === 'artifact';
}

/** Top-level output fields that hold a file reference, for attaching files. */
export function fileFieldsOf(
  outputSchema: unknown,
  node?: Pick<WorkflowNode, 'config'>,
  outputVariant?: OutputVariantSelection,
): readonly FileField[] {
  const schema = selectedOutputSchema(outputSchema, node, outputVariant);
  return schemaProperties(schema).flatMap(([key, candidate]): FileField[] => {
    if (isFileReferenceSchema(candidate)) return [{ key, sometimes: false }];
    const variants: unknown = isRecord(candidate)
      ? (candidate.oneOf ?? candidate.anyOf)
      : undefined;
    return Array.isArray(variants) && variants.some(isFileReferenceSchema)
      ? [{ key, sometimes: true }]
      : [];
  });
}

function schemaProperties(schema: unknown): [string, unknown][] {
  if (!isRecord(schema)) return [];
  const properties = new Map<string, unknown>(
    isRecord(schema.properties) ? Object.entries(schema.properties) : [],
  );
  for (const key of ['oneOf', 'anyOf']) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants as unknown[])
      for (const [name, value] of schemaProperties(variant)) {
        if (!properties.has(name)) {
          properties.set(name, value);
          continue;
        }
        const previous = properties.get(name);
        const previousType = isRecord(previous)
          ? schemaValueType(previous)
          : undefined;
        const nextType = isRecord(value) ? schemaValueType(value) : undefined;
        if (previousType !== nextType) properties.set(name, {});
      }
  }
  return [...properties];
}

function schemaValueType(
  candidate: Readonly<Record<string, unknown>>,
): SchemaValueType | undefined {
  const type = Reflect.get(candidate, 'type');
  const isSchemaType =
    type === 'string' ||
    type === 'number' ||
    type === 'integer' ||
    type === 'boolean' ||
    type === 'object' ||
    type === 'array';
  return isSchemaType ? type : undefined;
}

/** A JSON path for one top-level property: `$.amount` or `$['a-b']`. */
export function propertyPath(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
    ? `$.${key}`
    : `$['${key.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}']`;
}
