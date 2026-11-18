import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { addChildCoverage } from './child-coverage.mjs';
import { createReach } from './source-lines.mjs';

const preload = new URL('./child-coverage-preload.mjs', import.meta.url).href;

// Source lines: 1 top level, 3 in a called function, 6 in one never called,
// 9 in a branch that never ran, 12 top level again.
const SOURCE = `const top: number = 1;
function ran(flag: boolean): number {
  const doubled: number = top * 2;
  return flag ? doubled : 0;
}
function never(): number {
  return 2;
}
function branch(flag: boolean): void {
  if (flag) {
    console.log('never');
  }
}
branch(false);
ran(true);
`;

function temporary(t) {
  // Node records the resolved path (macOS's tmpdir is a symbolic link).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'overlap-children-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A built package file with its map, run once by a child process. */
function runBuiltChild(root) {
  mkdirSync(join(root, 'packages/core/src'), { recursive: true });
  mkdirSync(join(root, 'packages/core/dist'), { recursive: true });
  const { outputText, sourceMapText } = ts.transpileModule(SOURCE, {
    fileName: 'rules.ts',
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      sourceMap: true,
    },
  });
  const map = JSON.parse(sourceMapText);
  map.sources = ['../src/rules.ts'];
  writeFileSync(join(root, 'packages/core/src/rules.ts'), SOURCE);
  const built = join(root, 'packages/core/dist', 'rules.js');
  writeFileSync(built, outputText);
  writeFileSync(`${built}.map`, JSON.stringify(map));
  const coverage = join(root, 'children');
  const child = spawnSync(process.execPath, [built], {
    env: { NODE_V8_COVERAGE: coverage },
  });
  assert.equal(child.status, 0, String(child.stderr));
  return coverage;
}

test('adds the source lines a child process ran inside functions', (t) => {
  const root = temporary(t);
  const coverage = runBuiltChild(root);
  const reach = createReach(root);
  addChildCoverage(reach, coverage, root);
  assert.deepEqual(reach.lines(), {
    'packages/core/src/rules.ts': [3, 4, 10],
  });
});

test('adds nothing when no child process wrote coverage', (t) => {
  const root = temporary(t);
  const reach = createReach(root);
  addChildCoverage(reach, join(root, 'children'), root);
  assert.deepEqual(reach.lines(), {});
});

/** What a grandchild started with an empty environment sees. */
function childCoverageSeenBy(environment) {
  const script = `
    import { spawnSync } from 'node:child_process';
    const { stdout } = spawnSync(
      process.execPath,
      ['-p', 'process.env.NODE_V8_COVERAGE ?? "none"'],
      { env: {}, encoding: 'utf8' },
    );
    process.stdout.write(stdout.trim());
  `;
  const result = spawnSync(
    process.execPath,
    [`--import=${preload}`, '--input-type=module', '--eval', script],
    { env: { PATH: process.env.PATH, ...environment }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('a test process gives its children coverage even with their own environment', () => {
  assert.equal(
    childCoverageSeenBy({
      PERTEXO_OVERLAP_CHILD_COVERAGE: '/tmp/children',
      VITEST_WORKER_ID: '1',
    }),
    '/tmp/children',
  );
});

test("Vitest's main process leaves its workers' environment alone", () => {
  assert.equal(
    childCoverageSeenBy({ PERTEXO_OVERLAP_CHILD_COVERAGE: '/tmp/children' }),
    'none',
  );
});
