import type { z } from 'zod';
import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_MERGE_EXECUTOR } from './definition.js';
import type { CORE_MERGE_INPUT_SCHEMA } from './validation.js';

type CoreMergeInput = z.output<typeof CORE_MERGE_INPUT_SCHEMA>;

/** Passes on what each selected branch produced, in branch order. */
export const coreMergeExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_MERGE_EXECUTOR,
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const { ledger, selectedBranchIds } = invocation.input as CoreMergeInput;
    return Promise.resolve({
      branches: Object.fromEntries(
        selectedBranchIds.map((branchId) => [
          branchId,
          ledger[branchId]?.output ?? null,
        ]),
      ),
      selectedBranchIds,
    });
  },
});
