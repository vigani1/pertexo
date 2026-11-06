import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { nodeArtifactReferenceSchema } from '@pertexo/node-sdk';
import {
  ARTIFACT_DESCRIPTOR_JSON_PATH,
  isArtifactDescriptor,
} from '../../src/artifacts/references/descriptor-shape.js';
import { collectArtifactReferences } from '../../src/artifacts/references/locks.repository.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
afterAll(() => pool.end());
const descriptorSchema = nodeArtifactReferenceSchema.unwrap();
const descriptor = {
  kind: 'artifact',
  artifactId: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
  byteLength: 17,
  mediaType: 'application/json',
  sha256: 'a'.repeat(64),
};
const cases = [
  { name: 'complete descriptor', value: descriptor },
  {
    name: 'incidental business ID',
    value: { artifactId: descriptor.artifactId },
  },
  ...descriptorSchema.keyof().options.map((field) => ({
    name: `missing ${field}`,
    value: Object.fromEntries(
      Object.entries(descriptor).filter(([key]) => key !== field),
    ),
  })),
  ...[
    undefined,
    null,
    false,
    7,
    'business',
    'ARTIFACT',
    'Artifact',
    ['artifact'],
    [['artifact']],
    ['business', 'artifact'],
    [],
    { name: 'artifact' },
  ].map((kind) => ({
    name: `kind ${JSON.stringify(kind)}`,
    value: { ...descriptor, kind },
  })),
  ...[
    descriptor.artifactId.toUpperCase(),
    'AbCdEfAb-CdEf-4aBc-8dEf-AbCdEfAbCdEf',
    null,
    7,
    [],
    [descriptor.artifactId],
    [[descriptor.artifactId]],
    {},
    'not-a-uuid',
    descriptor.artifactId.replaceAll('-', ''),
  ].map((artifactId) => ({
    name: `artifactId ${JSON.stringify(artifactId)}`,
    value: { ...descriptor, artifactId },
  })),
];

it.each(cases)(
  'keeps SQL and TypeScript extraction identical for $name',
  async ({ value }) => {
    const id = descriptorSchema.shape.artifactId.safeParse(value.artifactId);
    const expected =
      isArtifactDescriptor(value) && id.success ? [id.data.toLowerCase()] : [];
    const indexed = await pool.query<{ id: string }>(
      "select app.artifact_owner_ids($1::jsonb,'authored') id",
      [JSON.stringify(value)],
    );
    expect(indexed.rows.map((row) => row.id)).toEqual(expected);
    const path = await pool.query<{ reference: unknown }>(
      'select reference from jsonb_path_query($1::jsonb,$2::jsonpath) reference',
      [JSON.stringify(value), ARTIFACT_DESCRIPTOR_JSON_PATH],
    );
    expect(
      path.rows.flatMap(({ reference }) => {
        const id = descriptorSchema.shape.artifactId.safeParse(reference);
        return id.success ? [id.data.toLowerCase()] : [];
      }),
    ).toEqual(expected);
    // Admission rejects malformed IDs; stored ownership ignores them rather than granting a file.
    if (isArtifactDescriptor(value) && !id.success)
      expect(() => collectArtifactReferences(value)).toThrow();
    else
      expect(
        collectArtifactReferences(value).map((reference) =>
          reference.artifactId.toLowerCase(),
        ),
      ).toEqual(expected);
  },
);

it('keeps arrays containing descriptors and ordinary business objects valid', async () => {
  const value = {
    nested: [{ artifactId: descriptor.artifactId }, [descriptor]],
  };
  const expected = collectArtifactReferences(value).map(
    (reference) => reference.artifactId,
  );
  expect(expected).toEqual([descriptor.artifactId]);
  const result = await pool.query<{ id: string }>(
    "select app.artifact_owner_ids($1::jsonb,'authored') id",
    [JSON.stringify(value)],
  );
  expect(result.rows.map((row) => row.id)).toEqual(expected);
});

it('keeps shape recognition distinct from metadata validation', async () => {
  const value = {
    ...descriptor,
    byteLength: null,
    mediaType: null,
    sha256: null,
  };
  expect(isArtifactDescriptor(value)).toBe(true);
  expect(() => collectArtifactReferences(value)).toThrow();
  const result = await pool.query<{ id: string }>(
    "select app.artifact_owner_ids($1::jsonb,'authored') id",
    [JSON.stringify(value)],
  );
  expect(result.rows).toEqual([{ id: descriptor.artifactId }]);
});
