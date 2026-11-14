import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PENDING_DOCS,
  validatePendingDocs,
  inspectPackageDocs,
  validatePackageDoc,
} from './validate-package-docs.mjs';

const linked = 'Follow the [root rules](../../AGENTS.md); this adds to them.';

test('accepts an AGENTS.md that links the root rules', () => {
  assert.deepEqual(validatePackageDoc('packages/example', linked), []);
  assert.deepEqual(
    validatePackageDoc(
      'packages/example',
      'See [where code lives](../../AGENTS.md#where-code-lives).',
    ),
    [],
  );
});

test('refuses a missing AGENTS.md or one without the link', () => {
  assert.match(
    validatePackageDoc('packages/example', undefined).join(),
    /add an AGENTS\.md/u,
  );
  assert.match(
    validatePackageDoc('packages/example', 'Root rules apply.').join(),
    /link the root rules/u,
  );
});

test('lets a pending workspace go without, and drops it once documented', () => {
  const pending = PENDING_DOCS[0];
  assert.deepEqual(validatePackageDoc(pending, undefined), []);
  assert.match(
    validatePackageDoc(pending, linked).join(),
    /remove it from PENDING_DOCS/u,
  );
});

test('reads each workspace’s AGENTS.md from disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'package-docs-'));
  try {
    await mkdir(path.join(root, 'packages/documented'), { recursive: true });
    await mkdir(path.join(root, 'packages/bare'), { recursive: true });
    await writeFile(path.join(root, 'packages/documented/AGENTS.md'), linked);
    assert.deepEqual(await inspectPackageDocs(root), [
      'packages/bare: add an AGENTS.md from the package template.',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a workspace added to the pending list', () => {
  assert.deepEqual(validatePendingDocs(PENDING_DOCS), []);
  assert.match(
    validatePendingDocs([...PENDING_DOCS, 'packages/queue']).join(),
    /packages\/queue: PENDING_DOCS may only shrink/u,
  );
});
