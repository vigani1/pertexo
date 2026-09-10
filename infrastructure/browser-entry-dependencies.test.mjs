import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectBrowserEntryDependencies } from './browser-entry-dependencies.mjs';

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'pertexo-browser-entry-'));
  await mkdir(path.join(root, 'packages/example/src'), { recursive: true });
  await writeFile(
    path.join(root, 'packages/example/package.json'),
    JSON.stringify({
      name: '@fixture/example',
      exports: {
        '.': { browser: './dist/browser.js', node: './dist/server.js' },
        './server': { browser: false, node: './dist/server.js' },
      },
    }),
  );
  for (const [name, source] of Object.entries(files))
    await writeFile(path.join(root, 'packages/example/src', name), source);
  return root;
}

test('finds two-hop builtins and runtime re-exports', async () => {
  const root = await fixture({
    'index.ts': "export * from './middle.js';",
    'middle.ts': "export { value } from './leaf.js';",
    'leaf.ts':
      "import { readFile } from 'node:fs/promises'; export const value = readFile;",
  });
  const errors = await inspectBrowserEntryDependencies({
    root,
    entries: ['packages/example/src/index.ts'],
  });
  assert.match(errors.join('\n'), /reaches Node builtin node:fs\/promises/u);
});

test('ignores type-only imports and comments containing node:', async () => {
  const root = await fixture({
    'index.ts':
      "// node:fs is documentation only\nimport type { Value } from './types.js'; export const ok = true;",
    'types.ts':
      "import type { Stats } from 'node:fs'; export type Value = Stats;",
  });
  assert.deepEqual(
    await inspectBrowserEntryDependencies({
      root,
      entries: ['packages/example/src/index.ts'],
    }),
    [],
  );
});

test('uses browser export conditions and rejects server-only subpaths', async () => {
  const root = await fixture({
    'index.ts': "export { browserValue } from '@fixture/example';",
    'browser.ts': 'export const browserValue = true;',
    'server.ts': "import 'node:fs'; export const serverValue = true;",
  });
  assert.deepEqual(
    await inspectBrowserEntryDependencies({
      root,
      entries: ['packages/example/src/index.ts'],
    }),
    [],
  );
  await writeFile(
    path.join(root, 'packages/example/src/index.ts'),
    "export { serverValue } from '@fixture/example/server';",
  );
  assert.match(
    (
      await inspectBrowserEntryDependencies({
        root,
        entries: ['packages/example/src/index.ts'],
      })
    ).join('\n'),
    /server-only import|no browser export/u,
  );
});

test('rejects non-literal dynamic imports', async () => {
  const root = await fixture({
    'index.ts':
      "const target = './leaf.js'; export const load = () => import(target);",
  });
  assert.match(
    (
      await inspectBrowserEntryDependencies({
        root,
        entries: ['packages/example/src/index.ts'],
      })
    ).join('\n'),
    /dynamic import must use a string literal/u,
  );
});
