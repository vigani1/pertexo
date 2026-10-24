import { describe, expect, it } from 'vitest';

import {
  normalizeBeginInput,
  normalizeFinalizeInput,
  normalizeIdentity,
} from '../../src/artifacts/uploads/input.js';

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

describe('artifact upload media type contract', () => {
  it.each([
    'application/js\u000bon',
    'application/js\u001fon',
    'application/js\u007fon',
    'application/js\u0100on',
  ])('rejects an HTTP-unsafe value before reservation %#', (mediaType) => {
    expect(() => normalizeBeginInput(beginInput(mediaType))).toThrow();
  });

  it.each([
    ['text/plain', 'text/plain'],
    [' application/json; charset=utf-8 ', 'application/json; charset=utf-8'],
    [
      'application/vnd.pertexo+json;version=1',
      'application/vnd.pertexo+json;version=1',
    ],
  ])('normalizes supported values %#', (mediaType, expected) => {
    expect(normalizeBeginInput(beginInput(mediaType)).mediaType).toBe(expected);
  });

  it('rejects actor and route workspace mismatches while preserving allowed actor context', () => {
    expect(() =>
      normalizeBeginInput({
        ...beginInput('text/plain'),
        actor: { actorId, workspaceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      }),
    ).toThrow('Artifact upload metadata was not found');
    expect(() =>
      normalizeIdentity({
        actor: { actorId, workspaceId },
        identity: {
          artifactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          workspaceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      }),
    ).toThrow('Artifact upload metadata was not found');

    expect(
      normalizeFinalizeInput({
        actor: {
          actorId,
          workspaceId,
          kind: 'user',
          requestId: 'request-context',
        },
        expectedMetadata: {
          byteLength: 5,
          mediaType: 'text/plain',
          sha256,
        },
        identity: {
          artifactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          workspaceId,
        },
      }),
    ).toMatchObject({ actorId, workspaceId });
  });

  it('enforces independent idempotency, byte, hash, bounds', () => {
    expect(
      normalizeBeginInput({
        ...beginInput('text/plain'),
        byteLength: 5 * 1024 * 1024 * 1024,
        idempotencyKey: 'x'.repeat(128),
      }),
    ).toMatchObject({
      byteLength: 5 * 1024 * 1024 * 1024,
      idempotencyKey: 'x'.repeat(128),
    });
    for (const override of [
      { idempotencyKey: 'contains,delimiter' },
      { idempotencyKey: 'x'.repeat(129) },
      { byteLength: 5 * 1024 * 1024 * 1024 + 1 },
      { byteLength: Number.MAX_SAFE_INTEGER + 1 },
      { sha256: 'A'.repeat(64) },
    ])
      expect(() =>
        normalizeBeginInput({ ...beginInput('text/plain'), ...override }),
      ).toThrow();
  });
});
