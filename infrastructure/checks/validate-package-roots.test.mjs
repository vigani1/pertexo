import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PENDING_ROOTS,
  ROOT_CONCEPTS,
  inspectPackageRoots,
  validatePackageRoot,
} from './validate-package-roots.mjs';

test('accepts entry files and a package’s listed concepts', () => {
  assert.deepEqual(
    validatePackageRoot('packages/rate-limit', [
      'server.ts',
      ...Object.keys(ROOT_CONCEPTS['packages/rate-limit']),
    ]),
    [],
  );
  assert.deepEqual(
    validatePackageRoot('packages/example', ['index.ts', 'config.ts']),
    [],
  );
});

test('refuses a loose root file nobody listed', () => {
  assert.match(
    validatePackageRoot('packages/example', ['server.ts', 'helpers.ts']).join(),
    /packages\/example\/src\/helpers\.ts: a src root holds/u,
  );
});

test('refuses a listed concept that no longer exists', () => {
  assert.match(
    validatePackageRoot('packages/rate-limit', ['server.ts']).join(),
    /listed in ROOT_CONCEPTS but missing/u,
  );
});

test('lets a pending workspace keep its root until it is settled', () => {
  const pending = PENDING_ROOTS[0];
  assert.deepEqual(validatePackageRoot(pending, ['main.ts', 'loose.ts']), []);
  assert.match(
    validatePackageRoot(pending, ['main.ts']).join(),
    /remove it from PENDING_ROOTS/u,
  );
});

test('reads each workspace’s direct src files from disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'package-roots-'));
  try {
    await mkdir(path.join(root, 'packages/example/src/area'), {
      recursive: true,
    });
    await writeFile(path.join(root, 'packages/example/src/server.ts'), '');
    await writeFile(path.join(root, 'packages/example/src/stray.ts'), '');
    await writeFile(path.join(root, 'packages/example/src/area/inner.ts'), '');
    assert.deepEqual(await inspectPackageRoots(root), [
      'packages/example/src/stray.ts: a src root holds entry files and named core concepts; move it into an area or list it with a reason in ROOT_CONCEPTS.',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
