import { describe, expect, it } from 'vitest';

import { runBypass } from '../../support/scheduling/skipped-parallel.js';

describe('skipped Parallel/Merge public execution', () => {
  it.each(['condition', 'switch'] as const)(
    'bypasses a skipped %s Parallel/Merge region without creating a join',
    async (kind) => {
      const { resumed } = await runBypass(kind);
      expect(resumed.checkpoint.joins).toEqual([]);
      expect(resumed.checkpoint.invocations).not.toContainEqual(
        expect.objectContaining({ nodeId: 'merge', status: 'running' }),
      );
    },
  );
});
