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

test('rejects malformed counters and key correspondence in the first report', () => {
  for (const mutate of [
    (entry) => {
      delete entry.s[0];
    },
    (entry) => {
      entry.s[1] = 1;
    },
    (entry) => {
      entry.f[0] = -1;
    },
    (entry) => {
      entry.s[0] = 1.5;
    },
    (entry) => {
      entry.b[0][0] = Number.NaN;
    },
    (entry) => {
      entry.b[0].push(0);
    },
    (entry) => {
      entry.path = '/workspace/other.ts';
    },
    (entry) => {
      entry.statementMap[0] = null;
    },
  ]) {
    const changed = coverage(1);
    mutate(changed['/workspace/file.ts']);
    assert.throws(() => mergeIstanbulCoverage([changed]), /coverage/iu);
  }
  assert.throws(() => mergeIstanbulCoverage([]), /nonempty array/u);
  assert.throws(() => mergeIstanbulCoverage([null]), /report 1 is malformed/u);
});

test('rejects missing and malformed counters in later reports', () => {
  const missing = coverage(1);
  delete missing['/workspace/file.ts'].b[0];
  assert.throws(
    () => mergeIstanbulCoverage([coverage(1), missing]),
    /branchMap\/b keys differ/u,
  );

  const overflow = coverage(Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => mergeIstanbulCoverage([overflow, coverage(1)]),
    /hit count is invalid.*sum/iu,
  );
});
