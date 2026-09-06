import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { validateDocumentationRepository } from './validate-documentation.mjs';
import { isolatedGitEnvironment } from './git-environment.mjs';

const execute = promisify(execFile);

async function command(root, ...args) {
  return execute('git', ['-C', root, ...args], {
    env: isolatedGitEnvironment(),
  });
}

async function createRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pertexo-docs-'));
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

test('accepts local links, anchors, and aligned audit trees', async () => {
  const { root, auditedTree } = await createRepository();
  const result = await validateDocumentationRepository(root);
  assert.deepEqual(result, {
    auditedTree,
    filesChecked: 4,
    localLinksChecked: 1,
  });
});

test('rejects a missing local target while ignoring examples and external links', async () => {
  const { root } = await createRepository();
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

test('rejects a missing heading anchor', async () => {
  const { root } = await createRepository();
  await writeFile(
    path.join(root, 'README.md'),
    '[Audit](./docs/whole-repository-audit.md#not-a-heading)\n',
  );
  await assert.rejects(
    validateDocumentationRepository(root),
    /README\.md: heading anchor does not exist:.*#not-a-heading/u,
  );
});

test('rejects tracker drift from the audited implementation tree', async () => {
  const { root } = await createRepository();
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

test('rejects an audit tree that does not occur in publication ancestry', async () => {
  const { root } = await createRepository();
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

test('accepts a matching implementation tree recreated by a rebase-style merge', async () => {
  const { root } = await createRepository();
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
