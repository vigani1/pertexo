import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { validateDocumentationRepository } from './validate-documentation.mjs';

const execute = promisify(execFile);

async function command(root, ...args) {
  return execute('git', ['-C', root, ...args]);
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
  const { stdout } = await command(root, 'rev-parse', 'HEAD');
  const auditedHead = stdout.trim();
  await writeFile(
    path.join(root, 'README.md'),
    '[Audit](./docs/whole-repository-audit.md#current-findings)\n',
  );
  await writeFile(
    path.join(root, 'docs/whole-repository-audit.md'),
    '# Audit\n\n' +
      `Audited implementation head: \`${auditedHead}\`\n\n` +
      '## Current findings\n',
  );
  await writeFile(
    path.join(root, 'docs/implementation-progress.md'),
    `# Progress\n\n## Current whole-repository audit — implementation head \`${auditedHead.slice(0, 7)}\`\n`,
  );
  await writeFile(
    path.join(root, 'docs/current-implementation-status.md'),
    `# Status\n\nAudited implementation head: \`${auditedHead}\`\n`,
  );
  await command(root, 'add', 'README.md', 'docs');
  await command(root, 'commit', '--quiet', '-m', 'add documentation');
  return { root, auditedHead };
}

test('accepts local links, anchors, and aligned audit heads', async () => {
  const { root, auditedHead } = await createRepository();
  const result = await validateDocumentationRepository(root);
  assert.deepEqual(result, {
    auditedHead,
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

test('rejects tracker drift from the audited implementation head', async () => {
  const { root } = await createRepository();
  await writeFile(
    path.join(root, 'docs/implementation-progress.md'),
    '# Progress\n\n' +
      '## Current whole-repository audit — implementation head `deadbee`\n',
  );
  await assert.rejects(
    validateDocumentationRepository(root),
    /implementation-progress\.md audit head must match/u,
  );
});

test('rejects an audit head that is not an ancestor of the publication', async () => {
  const { root } = await createRepository();
  const missingHead = '0123456789abcdef0123456789abcdef01234567';
  for (const file of [
    'docs/whole-repository-audit.md',
    'docs/current-implementation-status.md',
  ]) {
    const contents = file.endsWith('whole-repository-audit.md')
      ? `# Audit\n\nAudited implementation head: \`${missingHead}\`\n\n## Current findings\n`
      : `# Status\n\nAudited implementation head: \`${missingHead}\`\n`;
    await writeFile(path.join(root, file), contents);
  }
  await writeFile(
    path.join(root, 'docs/implementation-progress.md'),
    `# Progress\n\n## Current whole-repository audit — implementation head \`${missingHead.slice(0, 7)}\`\n`,
  );
  await assert.rejects(
    validateDocumentationRepository(root),
    /audited implementation head must resolve to an ancestor/u,
  );
});
