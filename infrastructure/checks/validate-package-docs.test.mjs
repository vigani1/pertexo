import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectPackageDocs,
  validatePackageDoc,
} from './validate-package-docs.mjs';

const headings = [
  'Purpose and boundary',
  'Layout',
  'Where new code goes',
  'Defaults and config',
  'Rules',
  'Exceptions',
  'What guards it',
];
const linked = `Follow the [root rules](../../AGENTS.md); this adds to them.\n${headings.map((heading) => `## ${heading}`).join('\n')}`;

test('accepts an AGENTS.md that links the root rules', () => {
  assert.deepEqual(validatePackageDoc('packages/example', linked), []);
  assert.deepEqual(
    validatePackageDoc(
      'packages/example',
      linked.replace('../../AGENTS.md', '../../AGENTS.md#where-code-lives'),
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

test('refuses every missing shared heading', () => {
  for (const missing of headings) {
    const text = `Follow [root rules](../../AGENTS.md).\n${headings
      .filter((heading) => heading !== missing)
      .map((heading) => `## ${heading}`)
      .join('\n')}`;
    assert.match(
      validatePackageDoc('packages/example', text).join(),
      new RegExp(missing),
    );
  }
});
