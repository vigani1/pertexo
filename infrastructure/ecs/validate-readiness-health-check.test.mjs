import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  readinessHealthCheckCommand,
  validateReadinessHealthCheck,
} from './validate-readiness-health-check.mjs';

const execFileAsync = promisify(execFile);

const contract = {
  ready: '/tmp/pertexo-worker-ready',
  notReady: '/tmp/pertexo-worker-not-ready',
};

test('worker health requires ready and rejects readiness revocation', () => {
  assert.doesNotThrow(() =>
    validateReadinessHealthCheck(
      'worker',
      [
        'CMD-SHELL',
        'test -f /tmp/pertexo-worker-ready && test ! -f /tmp/pertexo-worker-not-ready && kill -0 1',
      ],
      contract,
    ),
  );
  assert.throws(
    () =>
      validateReadinessHealthCheck(
        'worker',
        ['CMD-SHELL', 'test -f /tmp/pertexo-worker-ready && kill -0 1'],
        contract,
      ),
    /must equal its readiness contract/u,
  );
});

test('rejects commands that merely mention or bypass readiness checks', () => {
  for (const command of [
    'echo test -f /tmp/pertexo-worker-ready && test ! -f /tmp/pertexo-worker-not-ready && kill -0 1',
    'test -f /tmp/pertexo-worker-ready && test ! -f /tmp/pertexo-worker-not-ready && kill -0 1 || true',
    'test -f /tmp/wrong-ready && test ! -f /tmp/pertexo-worker-not-ready && kill -0 1',
    'test -f /tmp/pertexo-worker-ready && kill -0 1',
  ])
    assert.throws(
      () =>
        validateReadinessHealthCheck(
          'worker',
          ['CMD-SHELL', command],
          contract,
        ),
      /must equal its readiness contract/u,
    );
});

test('the owned conjunction fails while readiness is absent or revoked', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'pertexo-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [
    '--eval',
    'setInterval(() => {}, 1000)',
  ]);
  t.after(async () => {
    if (child.exitCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  });
  const ready = resolve(directory, 'ready');
  const notReady = resolve(directory, 'not-ready');
  const command = readinessHealthCheckCommand({ ready, notReady }, child.pid);
  await assert.rejects(execFileAsync('/bin/sh', ['-c', command]));
  await writeFile(ready, '');
  await assert.doesNotReject(execFileAsync('/bin/sh', ['-c', command]));
  await writeFile(notReady, '');
  await assert.rejects(execFileAsync('/bin/sh', ['-c', command]));
});
