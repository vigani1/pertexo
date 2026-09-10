import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateBuiltPackageExports } from './validate-built-package-exports.mjs';

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
            packageDirectory: current.packageDirectory,
            specifier: '@fixture/package',
          },
          {
            conditions: ['browser'],
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
