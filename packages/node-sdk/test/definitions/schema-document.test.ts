import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  boundedNodeJsonSchema,
  generateSchemaDocument,
} from '../../src/index.js';

it('projects the shared bounded JSON inside an output union while preserving own keys at runtime', () => {
  const schema = z.union([
    boundedNodeJsonSchema,
    z.object({ pages: z.array(z.string()) }),
  ]);
  const value: unknown = JSON.parse(
    '[{"__proto__":"data","constructor":"text"}]',
  );
  expect(JSON.stringify(schema.parse(value))).toBe(JSON.stringify(value));
  const projection = generateSchemaDocument(schema);
  expect(projection.anyOf).toHaveLength(2);
  if (!Array.isArray(projection.anyOf))
    throw new Error('Missing output variants');
  expect(projection.anyOf[0]).toHaveProperty(
    'x-pertexo-node-json-limits.bytes',
    1048576,
  );
});
it('continues to refuse unregistered transforms and other unrepresentable schemas', () => {
  for (const schema of [
    z.string().transform((value) => value.length),
    z.object({ when: z.date() }),
    z.union([z.json(), z.custom()]),
  ])
    expect(() => generateSchemaDocument(schema)).toThrow();
});
