import { expect, it } from 'vitest';

import { loadBuiltEntry } from '../support/built-entry.js';

it('loads @pertexo/core/previews as a built package with what its callers use', async () => {
  const names = await loadBuiltEntry('@pertexo/core/previews');
  expect(names).toEqual(expect.arrayContaining(['WorkflowTestError']));
}, 60_000);
