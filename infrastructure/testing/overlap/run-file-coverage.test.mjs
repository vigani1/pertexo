import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { reachedSourceLines } from './run-file-coverage.mjs';

const position = (line, column = 0) => ({ line, column });

// Istanbul entry: one function spanning lines 1-3, statements at lines 1, 2
// and 3 (the last never ran) and a top-level statement at line 5 that ran.
function entry() {
  return {
    statementMap: {
      0: { start: position(1), end: position(1, 9) },
      1: { start: position(2, 2), end: position(2, 9) },
      2: { start: position(3, 2), end: position(3, 9) },
      3: { start: position(5), end: position(5, 9) },
    },
    s: { 0: 1, 1: 4, 2: 0, 3: 1 },
    fnMap: { 0: { loc: { start: position(1), end: position(3, 10) } } },
  };
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'overlap-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/core/src'), { recursive: true });
  mkdirSync(join(root, 'packages/core/dist'), { recursive: true });
  return root;
}

test('counts executed statements inside functions, not the module top level', (t) => {
  const root = workspace(t);
  const reached = reachedSourceLines(
    { [join(root, 'packages/core/src/rules.ts')]: entry() },
    root,
  );
  assert.deepEqual(reached, { 'packages/core/src/rules.ts': [1, 2] });
});

test('maps a built file back to its source through the source map', (t) => {
  const root = workspace(t);
  const built = join(root, 'packages/core/dist', 'rules.js');
  writeFileSync(built, 'x\n//# sourceMappingURL=rules.js.map\n');
  // Generated line 1 -> source line 4, generated line 2 col 2 -> source line 6.
  writeFileSync(
    `${built}.map`,
    JSON.stringify({
      version: 3,
      sources: ['../src/rules.ts'],
      names: [],
      mappings: 'AAGA;EAEA',
    }),
  );
  const reached = reachedSourceLines({ [built]: entry() }, root);
  assert.deepEqual(reached, { 'packages/core/src/rules.ts': [4, 6] });
});

test('drops a built line the source map does not cover', (t) => {
  const root = workspace(t);
  const built = join(root, 'packages/core/dist', 'rules.js');
  writeFileSync(built, 'x\n//# sourceMappingURL=rules.js.map\n');
  writeFileSync(
    `${built}.map`,
    JSON.stringify({
      version: 3,
      sources: ['../src/rules.ts'],
      names: [],
      mappings: 'AAGA;EAEA',
    }),
  );
  // Only line 3 ran, and the map says nothing about it; the nearest earlier
  // mapping (line 2) belongs to a statement that never ran.
  const onlyLineThree = {
    ...entry(),
    s: { 0: 0, 1: 0, 2: 1, 3: 0 },
  };
  assert.deepEqual(reachedSourceLines({ [built]: onlyLineThree }, root), {});
});

test('refuses a built file without a source map', (t) => {
  const root = workspace(t);
  const built = join(root, 'packages/core/dist', 'rules.js');
  writeFileSync(built, 'x\n');
  assert.throws(
    () => reachedSourceLines({ [built]: entry() }, root),
    /no source map/,
  );
});

test('leaves out tests, tooling and dependencies', (t) => {
  const root = workspace(t);
  const reached = reachedSourceLines(
    {
      [join(root, 'packages/core/test/rules.test.ts')]: entry(),
      [join(root, 'infrastructure/testing/stack.mjs')]: entry(),
      [join(root, 'node_modules/zod/index.js')]: entry(),
    },
    root,
  );
  assert.deepEqual(reached, {});
});
