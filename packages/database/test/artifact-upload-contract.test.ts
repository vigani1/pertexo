import { describe, expect, it } from 'vitest';

import {
  mapArtifact,
  normalizeBeginInput,
} from '../src/execution/artifact-upload-contract.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sha256 = 'a'.repeat(64);

function beginInput(mediaType: string) {
  return {
    actor: { actorId, workspaceId },
    byteLength: 5,
    idempotencyKey: 'artifact-media-type-test',
    mediaType,
    sha256,
    workspaceId,
  };
}

function artifactRow(mediaType: string): Record<string, unknown> {
  const createdAt = new Date('2026-09-09T00:00:00.000Z');
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workspace_id: workspaceId,
    purpose: 'user-upload',
    storage_key:
      'workspaces/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/artifacts/cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    media_type: mediaType,
    byte_length: 5,
    sha256,
    status: 'pending',
    expires_at: new Date('2026-09-09T00:15:00.000Z'),
    finalized_at: null,
    deleted_at: null,
    retention_retry_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe('artifact upload media type contract', () => {
  it.each([
    'application/js\u000bon',
    'application/js\u001fon',
    'application/js\u007fon',
    'application/js\u0100on',
  ])(
    'rejects an HTTP-unsafe value before reservation and on row mapping %#',
    (mediaType) => {
      expect(() => normalizeBeginInput(beginInput(mediaType))).toThrow();
      expect(() => mapArtifact(artifactRow(mediaType))).toThrow();
    },
  );

  it.each([
    ['text/plain', 'text/plain'],
    [' application/json; charset=utf-8 ', 'application/json; charset=utf-8'],
    [
      'application/vnd.pertexo+json;version=1',
      'application/vnd.pertexo+json;version=1',
    ],
  ])('normalizes supported values %#', (mediaType, expected) => {
    expect(normalizeBeginInput(beginInput(mediaType)).mediaType).toBe(expected);
    expect(mapArtifact(artifactRow(expected)).mediaType).toBe(expected);
  });
});
