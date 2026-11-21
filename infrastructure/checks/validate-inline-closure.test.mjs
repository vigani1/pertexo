import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCoreInlineBindings } from './validate-inline-closure.mjs';

function fixture(t, kernel, dependency = 'export const value = 1;') {
  const root = mkdtempSync(join(tmpdir(), 'pertexo-inline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'packages/nodes-core/src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'bindings.ts'),
    "import { kernel } from './kernel.js'; export const binding = { executeInline: kernel };",
  );
  writeFileSync(join(dir, 'kernel.ts'), kernel);
  writeFileSync(join(dir, 'dependency.ts'), dependency);
  return root;
}

test('allows explicit date arithmetic in a transitively imported kernel', (t) => {
  const root = fixture(
    t,
    "export { value as kernel } from './dependency.js';",
    'export const value = new Date(0).getTime() + Math.floor(0.5);',
  );
  assert.doesNotThrow(() => checkCoreInlineBindings(root));
});

for (const [source, reason] of [
  ['import "node:fs";', /Node builtin/u],
  ['import "fs/promises";', /Node builtin/u],
  ...[
    'undici',
    'pg',
    'fs-extra',
    'execa',
    '@pertexo/database/platform',
    '@pertexo/secrets/server',
    '@pertexo/integrations/server',
    '@pertexo/worker',
  ].map((name) => [`import "${name}";`, /forbidden package/u]),
  ['fetch("https://example.com")', /forbidden API fetch/u],
  ['new WebSocket("ws://example.com")', /forbidden API WebSocket/u],
  ['process.env', /forbidden API process/u],
  ['setTimeout(() => {}, 1)', /forbidden API setTimeout/u],
  ['performance.now()', /forbidden API performance/u],
  ['Date.now()', /Date requires explicit input/u],
  ['new Date()', /Date requires explicit input/u],
  ['Math.random()', /Math.random/u],
  ['crypto.randomUUID()', /forbidden API crypto/u],
  ['import("./dependency.js")', /dynamic import/u],
  ['eval("1")', /forbidden API eval/u],
  ['new Function("return 1")', /forbidden API Function/u],
  [`(() => {})['constructor']("return 1")`, /indirect Function constructor/u],
  ['require("fs")', /forbidden API require/u],
]) {
  test(`rejects ${source} through a re-export`, (t) => {
    const root = fixture(
      t,
      "export { value as kernel } from './dependency.js';",
      source,
    );
    assert.throws(() => checkCoreInlineBindings(root), reason);
  });
}

test('ignores erased imports and re-exports', (t) => {
  const root = fixture(
    t,
    `
    import type { ReadStream } from 'node:fs';
    export type { Client } from 'pg';
    export const kernel = () => ({ kind: 'succeeded', output: null });
  `,
  );
  assert.doesNotThrow(() => checkCoreInlineBindings(root));
});

test('checks a pure export even when no kernel imports it', (t) => {
  const root = fixture(t, 'export const kernel = () => null;');
  const dir = join(root, 'packages/workflow-model');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      exports: {
        './pure': { types: './dist/pure.d.ts', default: './dist/pure.js' },
      },
    }),
  );
  writeFileSync(join(dir, 'src/pure.ts'), 'export const value = Date.now();');
  assert.throws(
    () => checkCoreInlineBindings(root),
    /Date requires explicit input/u,
  );
});

test('rejects workspace barrels and relative paths into other packages', (t) => {
  const root = fixture(t, "import '@pertexo/workflow-model';");
  assert.throws(() => checkCoreInlineBindings(root), /forbidden package/u);
  const dir = join(root, 'packages/workflow-model/src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'value.ts'), 'export const value = 1;');
  writeFileSync(
    join(root, 'packages/nodes-core/src/kernel.ts'),
    "export { value as kernel } from '../../workflow-model/src/value.js';",
  );
  assert.throws(() => checkCoreInlineBindings(root), /forbidden source path/u);
});
