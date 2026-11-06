import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  inspectBrowserEntryDependencies,
  WEB_BROWSER_PACKAGE_ROOTS,
} from './browser-entry-dependencies.mjs';

async function fixture(t, files, options = {}) {
  const root = await mkdtemp(
    path.join(options.parent ?? tmpdir(), 'pertexo-browser-entry-'),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  if (options.failAfterAllocation === true)
    throw new Error('injected browser fixture setup failure');
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

test('finds two-hop builtins and runtime re-exports', async (t) => {
  const root = await fixture(t, {
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

test('ignores type-only imports and comments containing node:', async (t) => {
  const root = await fixture(t, {
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

test('uses browser export conditions and rejects server-only subpaths', async (t) => {
  const root = await fixture(t, {
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

test('rejects non-literal dynamic imports', async (t) => {
  const root = await fixture(t, {
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

test('removes only its owned fixture after success and setup failure', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pertexo-browser-parent-'));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const unrelated = path.join(parent, 'unrelated.txt');
  await writeFile(unrelated, 'retained\n');

  await t.test('successful setup', async (child) => {
    await fixture(child, { 'index.ts': 'export const ok = true;' }, { parent });
  });
  assert.deepEqual(await readdir(parent), ['unrelated.txt']);

  await t.test('failed setup', async (child) => {
    await assert.rejects(
      fixture(child, {}, { failAfterAllocation: true, parent }),
      /injected browser fixture setup failure/u,
    );
  });
  assert.deepEqual(await readdir(parent), ['unrelated.txt']);
});

test('lets browser consumers load the execution and node package roots', async () => {
  assert.deepEqual(
    await inspectBrowserEntryDependencies({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      entries: [
        'packages/workflow-engine/src/index.ts',
        ...WEB_BROWSER_PACKAGE_ROOTS.map(
          (name) => `packages/${name.slice('@pertexo/'.length)}/src/index.ts`,
        ),
      ],
    }),
    [],
  );
});

const runtimePackages = [
  'queue',
  'rate-limit',
  'artifact-store',
  'observability',
];
function importEntries(entries, conditions = []) {
  const script = `const result = {}; for (const entry of ${JSON.stringify(entries)}) { result[entry] = await import(entry).then(() => 'loaded', error => error.code ?? 'unexpected_error'); } console.log(JSON.stringify(result));`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [...conditions, '--input-type=module', '-e', script],
      {
        cwd: fileURLToPath(new URL('../../apps/worker', import.meta.url)),
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    ),
  );
}

test('Node runtime packages have only explicit server doors, with no runtime root', () => {
  const entries = runtimePackages.flatMap((name) => [
    `@pertexo/${name}`,
    `@pertexo/${name}/server`,
  ]);
  const results = importEntries(entries);
  for (const name of runtimePackages) {
    assert.equal(results[`@pertexo/${name}`], 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    assert.equal(results[`@pertexo/${name}/server`], 'loaded');
  }
});

test('browser resolution refuses runtime doors, including early instrumentation', () => {
  const entries = [
    ...runtimePackages.map((name) => `@pertexo/${name}/server`),
    '@pertexo/observability/startup',
  ];
  const results = importEntries(entries, ['--conditions=browser']);
  for (const entry of entries)
    assert.equal(results[entry], 'ERR_INVALID_PACKAGE_TARGET', entry);
});
