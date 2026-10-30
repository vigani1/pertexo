import { describe, expect, it, vi } from 'vitest';

import { readArtifactCapacity } from '../../src/artifacts/capacity.queries.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('artifact storage capacity observations', () => {
  it('rejects unsafe aggregate integers instead of publishing lossy metrics', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      {
        bytes: String(Number.MAX_SAFE_INTEGER + 1),
        count: '1',
        status: 'pending',
      },
    ]);
    const transaction = {
      db: { select: vi.fn(() => ({ from: vi.fn(() => ({ groupBy })) })) },
      workspaceId,
    } as never;

    await expect(readArtifactCapacity(transaction)).rejects.toThrow(
      'artifact bytes exceeds the safe metric integer range',
    );
  });
});
