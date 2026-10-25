import { describe, expect, it, vi } from 'vitest';

import {
  readArtifactCapacity,
  readExecutionStorageCapacity,
} from '../../src/artifacts/capacity.queries.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('artifact storage capacity observations', () => {
  it('returns complete zero observations for empty artifact and execution storage', async () => {
    const groupBy = vi.fn().mockResolvedValue([]);
    const select = vi
      .fn()
      .mockReturnValueOnce({ from: vi.fn(() => ({ groupBy })) })
      .mockReturnValueOnce({
        from: vi.fn().mockResolvedValue([{ bytes: '0', count: '0' }]),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockResolvedValue([{ bytes: '0', count: '0' }]),
      });
    const transaction = { db: { select }, workspaceId } as never;

    await expect(readArtifactCapacity(transaction)).resolves.toEqual([
      { bytes: 0, count: 0, status: 'available' },
      { bytes: 0, count: 0, status: 'deleted' },
      { bytes: 0, count: 0, status: 'deleting' },
      { bytes: 0, count: 0, status: 'pending' },
    ]);
    await expect(readExecutionStorageCapacity(transaction)).resolves.toEqual([
      { bytes: 0, count: 0, surface: 'event' },
      { bytes: 0, count: 0, surface: 'checkpoint' },
    ]);
  });

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
