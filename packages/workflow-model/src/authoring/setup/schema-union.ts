import { isRecord } from '../../values/json/object.js';
import type { WorkflowNode } from '../../graph/workflow-graph.schemas.js';

type NodeConfig = WorkflowNode['config'];

/**
 * A step whose setup takes one of several shapes, chosen by a property
 * every shape fixes with a `const` (Date's `operation`, say). Each choice
 * reads by the `const`'s `title`; the union's own title and description
 * name the choice itself.
 */
export type SchemaUnion = Readonly<{
  key: string;
  title: string | undefined;
  description: string | undefined;
  choices: readonly Readonly<{ value: string; label: string }>[];
  variants: ReadonlyMap<string, unknown>;
}>;

export function readSchemaUnion(schema: unknown): SchemaUnion | undefined {
  if (!isRecord(schema) || !Array.isArray(schema.oneOf)) return undefined;
  const variants: readonly unknown[] = schema.oneOf;
  const key = discriminatorKey(variants);
  if (key === undefined) return undefined;
  const choices = variants.map((variant) => {
    const property = propertyOf(variant, key);
    const value = String(property.const);
    return {
      value,
      label: typeof property.title === 'string' ? property.title : value,
    };
  });
  return {
    key,
    title: typeof schema.title === 'string' ? schema.title : undefined,
    description:
      typeof schema.description === 'string' ? schema.description : undefined,
    choices,
    variants: new Map(
      variants.map((variant, index) => [choices[index]?.value ?? '', variant]),
    ),
  };
}

/**
 * The setup after choosing another shape: the values both shapes share
 * stay, the new shape's other settings start at their defaults, and the
 * rest goes, so the stored setup always matches one shape.
 */
export function withUnionChoice(
  union: SchemaUnion,
  config: NodeConfig,
  choice: string,
): NodeConfig | undefined {
  const variant = union.variants.get(choice);
  if (!isRecord(variant) || !isRecord(variant.properties)) return undefined;
  const defaults = propertyDefaults(variant);
  const settings = Object.keys(variant.properties).flatMap(
    (key): [string, NodeConfig[string]][] => {
      const kept = config[key] ?? defaults[key];
      return key === union.key || kept === undefined ? [] : [[key, kept]];
    },
  );
  return { [union.key]: choice, ...Object.fromEntries(settings) };
}

function discriminatorKey(variants: readonly unknown[]): string | undefined {
  const [first] = variants;
  if (first === undefined || !isRecord(first) || !isRecord(first.properties))
    return undefined;
  return Object.keys(first.properties).find((key) =>
    variants.every(
      (variant) => typeof propertyOf(variant, key).const === 'string',
    ),
  );
}

function propertyOf(
  variant: unknown,
  key: string,
): Readonly<Record<string, unknown>> {
  const properties = isRecord(variant) ? variant.properties : undefined;
  const property = isRecord(properties) ? properties[key] : undefined;
  return isRecord(property) ? property : {};
}

/** The schema's own starting values: each property's `default`. */
export function propertyDefaults(schema: unknown): NodeConfig {
  const properties = isRecord(schema) ? schema.properties : undefined;
  if (!isRecord(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, candidate]) =>
      isRecord(candidate) &&
      'default' in candidate &&
      isJsonValue(candidate.default)
        ? [[key, structuredClone(candidate.default) as NodeConfig[string]]]
        : [],
    ),
  );
}

export function isJsonObject(value: unknown): value is NodeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
