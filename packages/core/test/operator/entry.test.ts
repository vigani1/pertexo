import { expect, it } from 'vitest';

import { loadBuiltEntry } from '../support/built-entry.js';

it('loads @pertexo/core/operator as a built package with what its callers use', async () => {
  await expect(loadBuiltEntry('@pertexo/core/operator')).resolves.toEqual([
    'OperatorCommandConflictError',
    'OperatorRunReplayMismatchError',
    'OperatorRunReplayNotExecutableError',
    'createOperatorCommandStore',
    'createOperatorRunReplayStore',
  ]);
}, 60_000);
