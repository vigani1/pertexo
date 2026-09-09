import { describe, expect, it, vi } from 'vitest';

import {
  artifactStorageKey,
  createPendingArtifact,
} from '../src/execution/artifacts.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const artifactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('artifact lifecycle metadata validation', () => {
  it.each([
    'application/js\u000bon',
    'application/js\u001fon',
    'application/js\u007fon',
    'application/js\u0100on',
  ])('rejects HTTP-unsafe media type metadata %#', async (mediaType) => {
    const insert = vi.fn();

    await expect(
      createPendingArtifact(
        {
          workspaceId,
          db: { insert },
        } as never,
        {
          artifactId,
          byteLength: 5,
          expiresAt: new Date('2026-09-09T00:15:00.000Z'),
          mediaType,
          purpose: 'user-upload',
          sha256: 'a'.repeat(64),
          storageKey: artifactStorageKey(workspaceId, artifactId),
        },
      ),
    ).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
