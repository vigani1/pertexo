import { isRecord } from '@pertexo/workflow-model';
import { fieldLabel } from '../field-units';
import {
  propertyDefaults,
  schemaFields,
  type NodeConfig,
  type SchemaFieldSpec,
} from './draft';

/**
 * A step whose setup takes one of several shapes, chosen by a property
 * every shape fixes with a `const` (Date's `operation`, say). Each choice
 * reads by the `const`'s `title`; the union's own title and description
 * name the choice itself.
 */
export type SchemaUnion = Readonly<{
  key: string;
  label: string;
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
    label: typeof schema.title === 'string' ? schema.title : fieldLabel(key),
    description:
      typeof schema.description === 'string' ? schema.description : undefined,
    choices,
    variants: new Map(
      variants.map((variant, index) => [choices[index]?.value ?? '', variant]),
    ),
  };
}

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
