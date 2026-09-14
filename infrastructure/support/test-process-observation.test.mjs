import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import { processExists, waitForFile } from './test-process-observation.mjs';

test('waitForFile propagates errors other than a missing path', async () => {
  await assert.rejects(waitForFile('\0', 1), {
    code: 'ERR_INVALID_ARG_VALUE',
  });
});

test('processExists reports missing processes and propagates invalid PIDs', () => {
  assert.equal(processExists(2 ** 31 - 1), false);
  assert.throws(() => processExists(Number.NaN), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
  assert.equal(processExists(process.pid), true);
});
