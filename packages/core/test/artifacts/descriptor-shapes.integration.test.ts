import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import {
  ARTIFACT_DESCRIPTOR_JSON_PATH,
  isArtifactDescriptor,
} from '../../src/artifacts/references/descriptor-shape.js';
import { collectArtifactReferences } from '../../src/artifacts/references/locks.repository.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
afterAll(() => pool.end());
const descriptor = {
  kind: 'artifact',
  artifactId: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
  byteLength: 17,
  mediaType: 'application/json',
  sha256: 'a'.repeat(64),
};
const cases = [
  { name: 'scalar artifact', value: descriptor, descriptor: true },
  {
    name: 'one-element kind array',
    value: { ...descriptor, kind: ['artifact'] },
    descriptor: false,
  },
  {
    name: 'nested kind array',
    value: { ...descriptor, kind: [['artifact']] },
    descriptor: false,
  },
  {
    name: 'multiple kinds',
    value: { ...descriptor, kind: ['business', 'artifact'] },
    descriptor: false,
  },
  {
    name: 'empty kind array',
    value: { ...descriptor, kind: [] },
    descriptor: false,
  },
  {
    name: 'scalar business kind',
    value: { ...descriptor, kind: 'business' },
    descriptor: false,
  },
  {
    name: 'null kind',
    value: { ...descriptor, kind: null },
    descriptor: false,
  },
  {
    name: 'object kind',
    value: { ...descriptor, kind: { name: 'artifact' } },
    descriptor: false,
  },
  {
    name: 'incidental ID',
    value: { artifactId: descriptor.artifactId },
    descriptor: false,
  },
  {
    name: 'array kind and fabricated metadata',
    value: {
      ...descriptor,
      kind: ['artifact'],
      byteLength: null,
      mediaType: null,
      sha256: null,
    },
    descriptor: false,
  },
  // Exact descriptor shapes enter metadata validation; malformed metadata cannot be admitted.
  {
    name: 'scalar kind and fabricated metadata',
    value: { ...descriptor, byteLength: null, mediaType: null, sha256: null },
    descriptor: true,
  },
] as const;
it.each(cases)(
  'keeps raw ownership and admission shape recognition aligned for $name',
  async (testCase) => {
    expect(isArtifactDescriptor(testCase.value)).toBe(testCase.descriptor);
    const result = await pool.query<{ reference: unknown }>(
      'select reference from jsonb_path_query($1::jsonb,$2::jsonpath) reference',
      [JSON.stringify(testCase.value), ARTIFACT_DESCRIPTOR_JSON_PATH],
    );
    expect(result.rows.map((row) => row.reference)).toEqual(
      testCase.descriptor ? [descriptor.artifactId] : [],
    );
    const indexed = await pool.query<{ id: string }>(
      "select app.artifact_owner_ids($1::jsonb,'authored') id",
      [JSON.stringify(testCase.value)],
    );
    expect(indexed.rows.map((row) => row.id)).toEqual(
      testCase.descriptor ? [descriptor.artifactId] : [],
    );
    if (!testCase.descriptor)
      expect(collectArtifactReferences(testCase.value)).toEqual([]);
  },
);
it('keeps arrays containing descriptors and ordinary business objects valid', async () => {
  const value = {
    nested: [{ artifactId: descriptor.artifactId }, [descriptor]],
  };
  expect(collectArtifactReferences(value)).toEqual([
    {
      artifactId: descriptor.artifactId,
      byteLength: 17,
      mediaType: 'application/json',
      sha256: 'a'.repeat(64),
    },
  ]);
  const result = await pool.query<{ found: boolean }>(
    'select exists(select 1 from jsonb_path_query($1::jsonb,$2::jsonpath)) found',
    [JSON.stringify(value), ARTIFACT_DESCRIPTOR_JSON_PATH],
  );
  expect(result.rows).toEqual([{ found: true }]);
  expect(() =>
    collectArtifactReferences({
      ...descriptor,
      byteLength: null,
      mediaType: null,
      sha256: null,
    }),
  ).toThrow();
});

it('normalizes mixed-case descriptor UUIDs in the derived index', async () => {
  const result = await pool.query<{ id: string }>(
    "select app.artifact_owner_ids($1::jsonb,'authored') id",
    [
      JSON.stringify({
        ...descriptor,
        artifactId: descriptor.artifactId.toUpperCase(),
      }),
    ],
  );
  expect(result.rows).toEqual([{ id: descriptor.artifactId }]);
});
