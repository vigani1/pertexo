import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  collectArtifactReferences,
  lockArtifactReferences,
  requireNodeArtifactReference,
} from '../../src/artifacts/references/repository.js';
import {ArtifactMetadataNotFoundError} from '../../src/artifacts/input.js';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const reference = {
  artifactId: '22222222-2222-4222-8222-222222222222',
  byteLength: 4,
  mediaType: 'application/octet-stream',
  sha256: 'a'.repeat(64),
};
const descriptor = { kind: 'artifact', ...reference };
function row(patch: Record<string, unknown> = {}) {
  const record = {
    id: reference.artifactId,
    purpose: 'user-upload',
    byte_length: 4,
    media_type: reference.mediaType,
    sha256: reference.sha256,
    preview_run_id: null,
    ...patch,
  };
  return [
    record.id,
    record.byte_length,
    record.media_type,
    record.sha256,
    record.purpose,
    record.preview_run_id,
  ];
}
describe('durable artifact references', () => {
  it('collects descriptors inside literal mappings, loops and arrays', () => {
    expect(
      collectArtifactReferences({
        nodes: [
          {
            inputMappings: { body: { kind: 'literal', value: descriptor } },
            structured: {
              body: {
                nodes: [
                  {
                    inputMappings: {
                      file: { kind: 'literal', value: descriptor },
                    },
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toEqual([reference, reference]);
  });
  it('does not authorize incidental artifact IDs', async () => {
    const query = vi.fn();
    await lockArtifactReferences(
      { query } as never,
      workspaceId,
      {
        artifactId: reference.artifactId,
      },
      workspaceId,
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('accepts exact metadata and rejects absent, mismatched or preview-owned authoring references', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()] });
    await expect(
      lockArtifactReferences(
        { query } as never,
        workspaceId,
        descriptor,
        workspaceId,
      ),
    ).resolves.toBeUndefined();
    for (const rows of [
      [],
      [row({ byte_length: 5 })],
      [row({ media_type: 'text/plain' })],
      [row({ sha256: 'b'.repeat(64) })],
      [row({ preview_run_id: '33333333-3333-4333-8333-333333333333' })],
    ]) {
      query.mockResolvedValue({ rows });
      await expect(
        lockArtifactReferences(
          { query } as never,
          workspaceId,
          descriptor,
          workspaceId,
        ),
      ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
    }
  });
  it('checks repeated IDs with differing claimed metadata rather than trusting the first one', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()] });
    await expect(
      lockArtifactReferences(
        { query } as never,
        workspaceId,
        [descriptor, { ...descriptor, sha256: 'b'.repeat(64) }],
        workspaceId,
      ),
    ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
  });
  it('checks the complete reference before handing a worker storage authority', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()] });
    await expect(
      requireNodeArtifactReference(
        { workspaceId, db: drizzle({ query } as never) } as never,
        reference,
      ),
    ).resolves.toBeUndefined();
    query.mockResolvedValue({ rows: [] });
    await expect(
      requireNodeArtifactReference(
        { workspaceId, db: drizzle({ query } as never) } as never,
        reference,
      ),
    ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
  });
});
