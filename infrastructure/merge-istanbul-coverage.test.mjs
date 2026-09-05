import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeIstanbulCoverage } from './merge-istanbul-coverage.mjs';

const coverage = (hits) => ({
  '/workspace/file.ts': {
    path: '/workspace/file.ts',
    statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } },
    fnMap: { 0: { name: 'value' } },
    branchMap: { 0: { type: 'if', locations: [{ start: { line: 1 } }] } },
    s: { 0: hits },
    f: { 0: hits },
    b: { 0: [hits] },
  },
});

test('sums identical Istanbul instrumentation without losing files', () => {
  const merged = mergeIstanbulCoverage([coverage(2), coverage(3)]);
  assert.deepEqual(merged['/workspace/file.ts']?.s, { 0: 5 });
  assert.deepEqual(merged['/workspace/file.ts']?.f, { 0: 5 });
  assert.deepEqual(merged['/workspace/file.ts']?.b, { 0: [5] });
});

test('rejects incompatible instrumentation maps', () => {
  const changed = coverage(1);
  changed['/workspace/file.ts'].statementMap[0].end.line = 2;
  assert.throws(
    () => mergeIstanbulCoverage([coverage(1), changed]),
    /instrumentation changed/u,
  );
});
