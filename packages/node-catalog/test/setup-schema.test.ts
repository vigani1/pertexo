import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { isRecord } from '@pertexo/workflow-model';

import { platformBrowserNodeDefinitionCatalog } from '../src/index.js';

// Step setup is drawn from the catalog schema (docs/feature-plans/
// step-setup-from-schema.md, option B): labels, descriptions and starting
// values travel in standard JSON Schema, so they must be valid there.
const definitions = platformBrowserNodeDefinitionCatalog().definitions;

/** Every `default` in a schema, with its JSON pointer. */
function defaultsIn(
  schema: unknown,
  pointer = '',
): readonly Readonly<{ pointer: string; value: unknown }>[] {
  if (Array.isArray(schema))
    return schema.flatMap((child, index) =>
      defaultsIn(child, `${pointer}/${String(index)}`),
    );
  if (!isRecord(schema)) return [];
  const own = 'default' in schema ? [{ pointer, value: schema.default }] : [];
  return [
    ...own,
    ...Object.entries(schema).flatMap(([key, child]) =>
      key === 'default' || key === 'const' || key === 'enum'
        ? []
        : defaultsIn(
            child,
            `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
          ),
    ),
  ];
}

function discriminator(variants: readonly unknown[]): string | undefined {
  const [first] = variants;
  if (!isRecord(first) || !isRecord(first.properties)) return undefined;
  return Object.keys(first.properties).find((key) =>
    variants.every(
      (variant) =>
        isRecord(variant) &&
        isRecord(variant.properties) &&
        isRecord(variant.properties[key]) &&
        typeof variant.properties[key].const === 'string',
    ),
  );
}

// These unions keep a builder of their own (format tiles, the schedule
// rule builder), which names each choice itself.
const OWN_BUILDER = new Set([
  'core.read_file',
  'core.create_file',
  'core.schedule',
]);

describe('step setup in the catalog schema', () => {
  it('keeps every default valid against the schema it sits in', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    let checked = 0;
    for (const { definition, configSchema } of definitions) {
      const id = `urn:pertexo:${definition.key}`;
      const { $schema: _, ...schema } = configSchema;
      ajv.addSchema({ ...schema, $id: id });
      for (const { pointer, value } of defaultsIn(schema)) {
        const validate = ajv.getSchema(`${id}#${pointer}`);
        expect(validate, `${definition.key}${pointer}`).toBeDefined();
        expect(
          validate?.(value),
          `${definition.key}${pointer}: ${JSON.stringify(validate?.errors)}`,
        ).toBe(true);
        checked += 1;
      }
    }
    // The steps whose setup starts filled in carry their starting values.
    expect(checked).toBeGreaterThan(40);
  });

  it('labels each choice of a union the generic setup draws', () => {
    const unions = definitions.flatMap(({ definition, configSchema }) => {
      const variants = configSchema.oneOf;
      if (!Array.isArray(variants) || OWN_BUILDER.has(definition.key))
        return [];
      const key = discriminator(variants);
      return key === undefined ? [] : [{ step: definition.key, key, variants }];
    });
    expect(unions.map(({ step }) => step).sort()).toEqual([
      'core.crypto',
      'core.date',
      'core.html',
      'core.number',
      'core.text',
      'core.xml',
    ]);
    for (const { step, key, variants } of unions)
      for (const variant of variants) {
        const property =
          isRecord(variant) && isRecord(variant.properties)
            ? variant.properties[key]
            : undefined;
        expect(
          isRecord(property) && typeof property.title === 'string',
          `${step} ${JSON.stringify(property)}`,
        ).toBe(true);
      }
  });

  it('names stored choice IDs in words', () => {
    const algorithm = definitions.find(
      ({ definition }) => definition.key === 'core.hmac',
    )?.configSchema.properties;
    expect(isRecord(algorithm) && algorithm.algorithm).toMatchObject({
      enum: ['sha256', 'sha512'],
      oneOf: [
        { const: 'sha256', title: 'SHA-256' },
        { const: 'sha512', title: 'SHA-512' },
      ],
    });
  });
});
