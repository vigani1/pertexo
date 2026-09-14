import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  localTarget,
  validateDocumentationRepository,
} from './validate-documentation.mjs';
import { isolatedGitEnvironment } from './git-environment.mjs';

const execute = promisify(execFile);

async function command(root, ...args) {
  return execute('git', ['-C', root, ...args], {
    env: isolatedGitEnvironment(),
  });
}

async function createRepository(t, options = {}) {
  const root = await mkdtemp(
    path.join(options.parent ?? os.tmpdir(), 'pertexo-docs-'),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  if (options.failAfterAllocation === true)
    throw new Error('injected documentation fixture setup failure');
  await mkdir(path.join(root, 'docs'));
  await command(root, 'init', '--quiet');
  await command(root, 'config', 'user.email', 'documentation@example.test');
  await command(root, 'config', 'user.name', 'Documentation Fixture');
  await writeFile(path.join(root, 'seed.txt'), 'seed\n');
  await command(root, 'add', 'seed.txt');
  await command(root, 'commit', '--quiet', '-m', 'seed');
  const { stdout } = await command(root, 'rev-parse', 'HEAD^{tree}');
  const auditedTree = stdout.trim();
  await writeFile(
    path.join(root, 'README.md'),
    '[Audit](./docs/whole-repository-audit.md#current-findings)\n',
  );
  await writeFile(
    path.join(root, 'docs/whole-repository-audit.md'),
    '# Audit\n\n' +
      `Audited implementation tree: \`${auditedTree}\`\n\n` +
      '## Current findings\n',
  );
  await writeFile(
    path.join(root, 'docs/implementation-progress.md'),
    `# Progress\n\n## Current whole-repository audit — implementation tree \`${auditedTree.slice(0, 7)}\`\n`,
  );
  await writeFile(
    path.join(root, 'docs/current-implementation-status.md'),
    `# Status\n\nAudited implementation tree: \`${auditedTree}\`\n`,
  );
  await command(root, 'add', 'README.md', 'docs');
  await command(root, 'commit', '--quiet', '-m', 'add documentation');
  return { root, auditedTree };
}

test('accepts local links, anchors, and aligned audit trees', async (t) => {
  const { root, auditedTree } = await createRepository(t);
  const result = await validateDocumentationRepository(root);
  assert.deepEqual(result, {
    auditedTree,
    filesChecked: 4,
    localLinksChecked: 1,
  });
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
    '[Audit](./docs/whole-repository-audit.md#not-a-heading)\n',
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

test('rejects tracker drift from the audited implementation tree', async (t) => {
  const { root } = await createRepository(t);
  await writeFile(
    path.join(root, 'docs/implementation-progress.md'),
    '# Progress\n\n' +
      '## Current whole-repository audit — implementation tree `deadbee`\n',
  );
  await assert.rejects(
    validateDocumentationRepository(root),
    /implementation-progress\.md audit tree must match/u,
  );
});

test('rejects an audit tree that does not occur in publication ancestry', async (t) => {
  const { root } = await createRepository(t);
  const missingTree = '0123456789abcdef0123456789abcdef01234567';
  for (const file of [
    'docs/whole-repository-audit.md',
    'docs/current-implementation-status.md',
  ]) {
    const contents = file.endsWith('whole-repository-audit.md')
      ? `# Audit\n\nAudited implementation tree: \`${missingTree}\`\n\n## Current findings\n`
      : `# Status\n\nAudited implementation tree: \`${missingTree}\`\n`;
    await writeFile(path.join(root, file), contents);
  }
  await writeFile(
    path.join(root, 'docs/implementation-progress.md'),
    `# Progress\n\n## Current whole-repository audit — implementation tree \`${missingTree.slice(0, 7)}\`\n`,
  );
  await assert.rejects(
    validateDocumentationRepository(root),
    /audited implementation tree must occur in the publication ancestry/u,
  );
});

test('accepts a matching implementation tree recreated by a rebase-style merge', async (t) => {
  const { root } = await createRepository(t);
  const { stdout: seedOutput } = await command(
    root,
    'rev-list',
    '--max-parents=0',
    'HEAD',
  );
  const seed = seedOutput.trim();

  await command(root, 'switch', '--quiet', '-c', 'candidate', seed);
  await writeFile(
    path.join(root, 'implementation.txt'),
    'reviewed implementation\n',
  );
  await command(root, 'add', 'implementation.txt');
  await command(root, 'commit', '--quiet', '-m', 'candidate implementation');
  const { stdout: candidateOutput } = await command(root, 'rev-parse', 'HEAD');
  const candidate = candidateOutput.trim();
  const { stdout: treeOutput } = await command(
    root,
    'rev-parse',
    'HEAD^{tree}',
  );
  const auditedTree = treeOutput.trim();

  await command(root, 'switch', '--quiet', '-c', 'publication', seed);
  await command(root, 'commit', '--quiet', '--allow-empty', '-m', 'new base');
  await writeFile(
    path.join(root, 'implementation.txt'),
    'reviewed implementation\n',
  );
  await command(root, 'add', 'implementation.txt');
  await command(root, 'commit', '--quiet', '-m', 'rebased implementation');
  await assert.rejects(
    command(root, 'merge-base', '--is-ancestor', candidate, 'HEAD'),
  );

  await mkdir(path.join(root, 'docs'));
  for (const file of [
    'docs/whole-repository-audit.md',
    'docs/current-implementation-status.md',
  ]) {
    const contents = file.endsWith('whole-repository-audit.md')
      ? `# Audit\n\nAudited implementation tree: \`${auditedTree}\`\n\n## Current findings\n`
      : `# Status\n\nAudited implementation tree: \`${auditedTree}\`\n`;
    await writeFile(path.join(root, file), contents);
  }
  await writeFile(
    path.join(root, 'docs/implementation-progress.md'),
    `# Progress\n\n## Current whole-repository audit — implementation tree \`${auditedTree.slice(0, 7)}\`\n`,
  );
  await writeFile(
    path.join(root, 'README.md'),
    '[Audit](./docs/whole-repository-audit.md#current-findings)\n',
  );
  await command(root, 'add', 'README.md', 'docs');
  await command(root, 'commit', '--quiet', '-m', 'publish audit');

  const result = await validateDocumentationRepository(root);
  assert.equal(result.auditedTree, auditedTree);
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
