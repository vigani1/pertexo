import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const oxlint = resolve(repository, 'node_modules/.bin/oxlint');

test('lint uses each source and test program without changing compiler files', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-lint-projects-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [
    'apps/example/src',
    'apps/example/test',
    'packages',
    'infrastructure/checks',
  ])
    mkdirSync(join(directory, path), { recursive: true });
  symlinkSync(
    resolve(repository, 'node_modules'),
    join(directory, 'node_modules'),
  );
  copyFileSync(
    new URL('./tsgolint-projects.mjs', import.meta.url),
    join(directory, 'infrastructure/checks/tsgolint-projects.mjs'),
  );
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  const files = {
    'tsconfig.base.json': '{"compilerOptions":{"strict":true}}',
    'tsconfig.json': '{"files":[]}',
    'apps/example/tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'apps/example/tsconfig.test.json': JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: {
        lib: ['es2025'],
        types: ['node'],
        paths: { '@fixture-values': ['./src/value.ts'] },
      },
      include: ['src/**/*.ts', 'test/**/*.ts', '*.config.ts'],
    }),
  };
  for (const [path, contents] of Object.entries(files))
    writeFileSync(join(directory, path), contents);
  writeFileSync(
    join(directory, 'apps/example/src/value.ts'),
    "export const payload = 'ready';",
  );
  writeFileSync(
    join(directory, 'apps/example/test/value.test.ts'),
    "import { payload } from '@fixture-values'; export const value: string = payload;",
  );
  writeFileSync(
    join(directory, 'apps/example/src/source-only.ts'),
    'export const resolvers = Promise.withResolvers<void>();',
  );
  writeFileSync(
    join(directory, 'apps/example/test/test-library.test.ts'),
    'export const resolvers = Promise.withResolvers<void>();',
  );
  writeFileSync(
    join(directory, 'apps/example/vitest.config.ts'),
    "import { payload } from '@fixture-values'; export const value: string = payload; Promise.resolve();",
  );
  writeFileSync(
    join(directory, 'oxlint.json'),
    JSON.stringify({
      plugins: ['typescript'],
      categories: { correctness: 'off' },
      rules: {
        'typescript/no-unsafe-assignment': 'error',
        'typescript/no-unsafe-call': 'error',
        'typescript/no-floating-promises': 'error',
      },
    }),
  );
  const invoke = (paths, adapter = true) => {
    const env = { ...process.env };
    delete env.OXLINT_TSGOLINT_PATH;
    if (adapter)
      env.OXLINT_TSGOLINT_PATH = join(
        directory,
        'infrastructure/checks/tsgolint-projects.mjs',
      );
    const result = spawnSync(
      oxlint,
      [
        '--type-aware',
        '--disable-nested-config',
        '-c',
        'oxlint.json',
        '--format',
        'json',
        ...paths,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env,
      },
    );
    assert.equal(result.error, undefined);
    return {
      status: result.status,
      diagnostics: JSON.parse(result.stdout).diagnostics,
    };
  };
  const testPath = 'apps/example/test/value.test.ts';
  assert.equal(invoke([testPath], false).status, 1);
  assert.deepEqual(invoke([testPath]).diagnostics, []);
  const programs = invoke([
    'apps/example/src/source-only.ts',
    'apps/example/test/test-library.test.ts',
  ]);
  assert.equal(programs.status, 1);
  assert.ok(programs.diagnostics.length > 0);
  assert.ok(
    programs.diagnostics.every(
      (item) => item.filename === 'apps/example/src/source-only.ts',
    ),
  );
  const tooling = invoke(['apps/example/vitest.config.ts']);
  assert.deepEqual(
    tooling.diagnostics.map((item) => item.code),
    ['typescript(no-floating-promises)'],
  );
  for (const [path, contents] of Object.entries(files))
    assert.equal(readFileSync(join(directory, path), 'utf8'), contents);
});
