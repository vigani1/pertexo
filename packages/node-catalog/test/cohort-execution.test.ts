import { describe, expect, it } from 'vitest';
import {
  CORE_MERGE_DEFINITION,
  CORE_MERGE_EXECUTOR,
  CORE_PARALLEL_DEFINITION,
  CORE_PARALLEL_EXECUTOR,
} from '@pertexo/nodes-core';

import {
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
} from '../src/registry.js';
import { createPlatformNodeRegistryForRelease } from '../src/server.js';

describe('platform cohort execution smoke contracts', () => {
  it('executes a settled Merge ledger in its active release', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
    );
    const input = {
      ledger: {
        'branch-01': { disposition: 'arrived' },
        'branch-02': { disposition: 'skipped' },
      },
      selectedBranchIds: ['branch-01'],
    };

    await expect(
      registry.execute({
        config: { parallelNodeId: 'parallel', policy: { kind: 'any' } },
        definition: CORE_MERGE_DEFINITION,
        executor: CORE_MERGE_EXECUTOR,
        input,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: input });
  });

  it('executes a bounded Parallel declaration in its active release', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
    );

    await expect(
      registry.execute({
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        definition: CORE_PARALLEL_DEFINITION,
        executor: CORE_PARALLEL_EXECUTOR,
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { branchIds: ['branch-02', 'branch-01'] },
    });
  });
});
