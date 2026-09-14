import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  localTarget,
  validateDocumentationRepository,
} from './validate-documentation.mjs';

async function createRepository(t, options = {}) {
  const root = await mkdtemp(
    path.join(options.parent ?? os.tmpdir(), 'pertexo-docs-'),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  if (options.failAfterAllocation === true)
    throw new Error('injected documentation fixture setup failure');
  await mkdir(path.join(root, 'docs'));
  await writeFile(
    path.join(root, 'README.md'),
    '[Guide](./docs/guide.md#development)\n',
  );
  await writeFile(
    path.join(root, 'docs/guide.md'),
    '# Guide\n\n## Development\n',
  );
  return { root };
}

test('accepts local links and anchors without audit records or Git metadata', async (t) => {
  const { root } = await createRepository(t);
  assert.deepEqual(await readdir(root), ['README.md', 'docs']);
  assert.deepEqual(await validateDocumentationRepository(root), {
    filesChecked: 2,
    localLinksChecked: 1,
  });
  assert.deepEqual(await readdir(root), ['README.md', 'docs']);
});

test('rejects a missing local target while ignoring examples and external links', async (t) => {
  const { root } = await createRepository(t);
  await writeFile(
    path.join(root, 'README.md'),
    '[Missing](./docs/missing.md)\n\n' +
      '[External](https://example.com/missing)\n\n' +
      '```md\n[Example](./docs/example-only.md)\n```\n',
  );
  await assert.rejects(
    validateDocumentationRepository(root),
    /README\.md: local link target does not exist: docs\/missing\.md/u,
  );
});

test('rejects a missing heading anchor', async (t) => {
  const { root } = await createRepository(t);
  await writeFile(
    path.join(root, 'README.md'),
    '[Guide](./docs/guide.md#not-a-heading)\n',
  );
  await assert.rejects(
    validateDocumentationRepository(root),
    /README\.md: heading anchor does not exist:.*#not-a-heading/u,
  );
});

test('resolves fragment-only, query, encoded, repeated, and empty local links against the source document', async (t) => {
  const { root } = await createRepository(t);
  await writeFile(
    path.join(root, 'README.md'),
    '# Local heading\n\n' +
      '## Repeated\n\n## Repeated\n\n' +
      '[Local](#local-heading)\n' +
      '[Query](?view=compact#local-heading)\n' +
      '[Encoded](#local%2Dheading)\n' +
      '[Second repeated](#repeated-1)\n' +
      '[Empty]()\n',
  );
  await assert.doesNotReject(validateDocumentationRepository(root));
});

test('rejects missing local fragments, invalid encoding, and repository escape', async (t) => {
  const { root } = await createRepository(t);
  for (const [href, pattern] of [
    [
      '#absent',
      /README\.md: heading anchor does not exist: README\.md#absent/u,
    ],
    ['../outside.md', /README\.md: local link escapes the repository/u],
  ]) {
    await writeFile(path.join(root, 'README.md'), `[Invalid](${href})\n`);
    await assert.rejects(validateDocumentationRepository(root), pattern);
  }
  assert.throws(
    () => localTarget(root, path.join(root, 'README.md'), '#bad%ZZ'),
    /link contains invalid percent encoding/u,
  );
});

test('checks nested documents and rejects heading anchors on non-Markdown targets', async (t) => {
  const { root } = await createRepository(t);
  await mkdir(path.join(root, 'docs/nested'));
  await writeFile(path.join(root, 'docs/config.json'), '{}\n');
  await writeFile(
    path.join(root, 'docs/nested/setup.md'),
    '[Config](../config.json#section)\n',
  );
  await assert.rejects(
    validateDocumentationRepository(root),
    /heading anchor targets a non-Markdown file/u,
  );
  await writeFile(
    path.join(root, 'docs/nested/setup.md'),
    '[Guide](../guide.md#development)\n',
  );
  const result = await validateDocumentationRepository(root);
  assert.equal(result.filesChecked, 3);
  assert.equal(result.localLinksChecked, 2);
});

test('removes only its owned repository after success and setup failure', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pertexo-docs-parent-'));
  t.after(() => rm(parent, { force: true, recursive: true }));
  await writeFile(path.join(parent, 'unrelated.txt'), 'retained\n');

  await t.test('successful setup', async (child) => {
    await createRepository(child, { parent });
  });
  assert.deepEqual(await readdir(parent), ['unrelated.txt']);

  await t.test('failed setup', async (child) => {
    await assert.rejects(
      createRepository(child, { failAfterAllocation: true, parent }),
      /injected documentation fixture setup failure/u,
    );
  });
  assert.deepEqual(await readdir(parent), ['unrelated.txt']);
});
