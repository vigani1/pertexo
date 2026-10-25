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
});
