import assert from 'node:assert/strict';
import test from 'node:test';

import { findBareHttpStatuses } from './validate-http-statuses.mjs';

const file = 'apps/api/src/sample.ts';

test('a status the API sends written as a number is refused', () => {
  for (const planted of [
    'new Response(null, { status: 404 });',
    'const problem = { statusCode: 403 };',
    'const schema = z.object({ status: z.literal(409) });',
  ])
    assert.equal(findBareHttpStatuses(file, planted).length, 1, planted);
});

test('HttpStatus, comparisons with a received number and other numbers pass', () => {
  for (const kept of [
    'new Response(null, { status: HttpStatus.NOT_FOUND });',
    'if (response.status === 429) retry();',
    'const ok = response.status >= 200 && response.status <= 299;',
    'const schema = z.object({ status: z.number().int().min(400).max(599) });',
    'const page = { limit: 404 };',
  ])
    assert.deepEqual(findBareHttpStatuses(file, kept), [], kept);
});
