import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ENVIRONMENT_READS_PENDING,
  inspectEnvironmentReads,
  isConfigModule,
  readsEnvironment,
  validateEnvironmentReads,
} from './validate-environment-reads.mjs';

test('knows a config module by its name or an app’s config folder', () => {
  for (const file of [
    'packages/example/src/config.ts',
    'packages/example/src/mail/config.ts',
    'apps/api/src/platform/config/api-config.ts',
    'apps/worker/src/config/system-mail.ts',
    'apps/ops/src/operator-config.ts',
  ])
    assert.equal(isConfigModule(file), true, file);
  for (const file of [
    'packages/example/src/configure.ts',
    'packages/example/src/runtime.ts',
    'packages/example/src/config/defaults.ts',
  ])
    assert.equal(isConfigModule(file), false, file);
});

test('finds process.env reads, not the words in a string', () => {
  assert.equal(readsEnvironment('a.ts', 'const a = process.env.PORT;'), true);
  assert.equal(readsEnvironment('a.ts', 'f(process.env);'), true);
  assert.equal(
    readsEnvironment('a.ts', "const snippet = 'process.env.SECRET';"),
    false,
  );
});

test('refuses a read outside config and a stale pending entry', () => {
  assert.deepEqual(
    validateEnvironmentReads([
      'packages/example/src/config.ts',
      ...ENVIRONMENT_READS_PENDING,
    ]),
    [],
  );
  assert.match(
    validateEnvironmentReads([
      'packages/example/src/runtime.ts',
      ...ENVIRONMENT_READS_PENDING,
    ]).join(),
    /runtime\.ts: read process\.env only in a config module/u,
  );
  assert.match(
    validateEnvironmentReads([]).join(),
    /remove it from ENVIRONMENT_READS_PENDING/u,
  );
});

test('scans every workspace’s src from disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'environment-reads-'));
  try {
    await mkdir(path.join(root, 'packages/example/src'), { recursive: true });
    await writeFile(
      path.join(root, 'packages/example/src/limits.ts'),
      'export const port = Number(process.env.PORT);',
    );
    await writeFile(
      path.join(root, 'packages/example/src/config.ts'),
      'export const port = Number(process.env.PORT);',
    );
    const findings = await inspectEnvironmentReads(root);
    assert.ok(
      findings.includes(
        'packages/example/src/limits.ts: read process.env only in a config module and pass the typed value inward.',
      ),
    );
    assert.ok(!findings.some((finding) => finding.includes('config.ts')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finds the environment read by destructuring, import, index or globalThis', () => {
  for (const text of [
    'const { env } = process;',
    'const { env: settings } = process;',
    "import { env } from 'node:process';",
    "import { env as settings } from 'process';",
    "const port = process['env'].PORT;",
    'const port = globalThis.process.env.PORT;',
  ])
    assert.equal(readsEnvironment('a.ts', text), true, text);
  assert.equal(
    readsEnvironment('a.ts', "import { argv } from 'node:process';"),
    false,
  );
});

test('refuses a file added to the pending list', () => {
  assert.match(
    validateEnvironmentReads(
      ['packages/example/src/runtime.ts', ...ENVIRONMENT_READS_PENDING],
      [...ENVIRONMENT_READS_PENDING, 'packages/example/src/runtime.ts'],
    ).join(),
    /runtime\.ts: ENVIRONMENT_READS_PENDING may only shrink/u,
  );
});
