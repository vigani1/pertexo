import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILT_PACKAGE_CONSUMER_CASES,
  validateBuiltPackageExports,
} from './validate-built-package-exports.mjs';

test('registers the process error classification leaf consumer', () => {
  assert.ok(
    BUILT_PACKAGE_CONSUMER_CASES.some(
      ({ specifier }) =>
        specifier === '@pertexo/observability/process-error-classification',
    ),
  );
});

test('registers every database role surface and rejects broad paths', () => {
  const databaseCases = BUILT_PACKAGE_CONSUMER_CASES.filter(
    ({ packageDirectory }) => packageDirectory === 'packages/database',
  );
  assert.deepEqual(
    databaseCases.map(({ specifier }) => specifier),
    [
      '@pertexo/database/api',
      '@pertexo/database/execution',
      '@pertexo/database/lifecycle',
      '@pertexo/database/maintenance',
      '@pertexo/database/operator',
      '@pertexo/database/recovery',
      '@pertexo/database/testing',
      '@pertexo/database',
      '@pertexo/database/src/config.js',
    ],
  );
  assert.ok(
    databaseCases
      .slice(0, 7)
      .every(({ requireTypes }) => requireTypes === true),
  );
  assert.ok(
    databaseCases
      .slice(7)
      .every(({ expected }) => expected === 'resolution-rejected'),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pertexo-built-exports-'));
  const packageDirectory = path.join(root, 'packages', 'fixture');
  await mkdir(path.join(packageDirectory, 'dist'), { recursive: true });
  await writeFile(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: '@fixture/package',
      type: 'module',
      exports: {
        '.': {
          browser: './dist/browser.js',
          node: './dist/node.js',
          default: './dist/browser.js',
        },
        './server': { browser: false, node: './dist/node.js' },
      },
    }),
  );
  await writeFile(
    path.join(packageDirectory, 'dist', 'browser.js'),
    'export const target = "browser";\n',
  );
  await writeFile(
    path.join(packageDirectory, 'dist', 'node.js'),
    'export const target = "node";\n',
  );
  return { packageDirectory: 'packages/fixture', root };
}

test('loads built self-references through node and browser export conditions', async () => {
  const current = await fixture();
  try {
    assert.deepEqual(
      await validateBuiltPackageExports({
        root: current.root,
        cases: [
          {
            expectedResolvedTarget: 'dist/node.js',
            packageDirectory: current.packageDirectory,
            specifier: '@fixture/package',
          },
          {
            conditions: ['browser'],
            expectedResolvedTarget: 'dist/browser.js',
            packageDirectory: current.packageDirectory,
            specifier: '@fixture/package',
          },
          {
            conditions: ['browser'],
            expected: 'browser-rejected',
            packageDirectory: current.packageDirectory,
            specifier: '@fixture/package/server',
          },
        ],
      }),
      [],
    );
  } finally {
    await rm(current.root, { force: true, recursive: true });
  }
});

test('bounds a referenced import timer and reports a reaped timeout', async () => {
  const current = await fixture();
  try {
    await writeFile(
      path.join(current.root, 'packages', 'fixture', 'dist', 'node.js'),
      'export const target = "node"; setInterval(() => {}, 1_000);\n',
    );
    const startedAt = Date.now();
    const failures = await validateBuiltPackageExports({
      importTimeoutMs: 100,
      root: current.root,
      cases: [
        {
          packageDirectory: current.packageDirectory,
          specifier: '@fixture/package',
        },
      ],
    });
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /built consumer import timed out after 100ms and was reaped/u,
    );
  } finally {
    await rm(current.root, { force: true, recursive: true });
  }
});

test('reports import spawn failure without exposing environment data', async () => {
  const current = await fixture();
  try {
    const failures = await validateBuiltPackageExports({
      importTimeoutMs: 100,
      nodeExecutable: path.join(current.root, 'missing-node'),
      root: current.root,
      cases: [
        {
          packageDirectory: current.packageDirectory,
          specifier: '@fixture/package',
        },
      ],
    });
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /built consumer import could not start .*ENOENT/u,
    );
    assert.doesNotMatch(failures[0], /PATH=/u);
  } finally {
    await rm(current.root, { force: true, recursive: true });
  }
});

test('does not mistake missing built output for a browser restriction', async () => {
  const current = await fixture();
  try {
    await rm(path.join(current.root, 'packages', 'fixture', 'dist'), {
      force: true,
      recursive: true,
    });
    const failures = await validateBuiltPackageExports({
      root: current.root,
      cases: [
        {
          conditions: ['browser'],
          expected: 'browser-rejected',
          packageDirectory: current.packageDirectory,
          specifier: '@fixture/package',
        },
      ],
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /did not reject the explicit false export/u);
  } finally {
    await rm(current.root, { force: true, recursive: true });
  }
});

test('rejects a case assigned to the wrong package owner', async () => {
  const current = await fixture();
  try {
    const failures = await validateBuiltPackageExports({
      root: current.root,
      cases: [
        {
          packageDirectory: current.packageDirectory,
          specifier: '@fixture/other',
        },
      ],
    });
    assert.deepEqual(failures, [
      'packages/fixture: @fixture/other is not a self-reference for @fixture/package',
    ]);
  } finally {
    await rm(current.root, { force: true, recursive: true });
  }
});

test('reports missing required and present forbidden exports', async () => {
  const current = await fixture();
  try {
    const failures = await validateBuiltPackageExports({
      root: current.root,
      cases: [
        {
          forbiddenExports: ['target'],
          packageDirectory: current.packageDirectory,
          requiredExports: ['missing'],
          specifier: '@fixture/package',
        },
      ],
    });
    assert.deepEqual(failures, [
      '@fixture/package: built entry is missing missing',
      '@fixture/package: built entry unexpectedly exports target',
    ]);
  } finally {
    await rm(current.root, { force: true, recursive: true });
  }
});

test('requires a resolvable built declaration when requested', async () => {
  const current = await fixture();
  try {
    const failures = await validateBuiltPackageExports({
      root: current.root,
      cases: [
        {
          packageDirectory: current.packageDirectory,
          requireTypes: true,
          specifier: '@fixture/package',
        },
      ],
    });
    assert.deepEqual(failures, [
      '@fixture/package: package export has no declaration target',
    ]);
  } finally {
    await rm(current.root, { force: true, recursive: true });
  }
});
