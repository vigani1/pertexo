import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  describeBoundedChildFailure,
  runBoundedChildProcess,
} from './bounded-child-process.mjs';
import { processExists } from './test-process-observation.mjs';

async function waitForExit(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await delay(20);
  }
  throw new Error(`Process ${String(pid)} was not reaped`);
}

test('returns exact success, nonzero, and spawn diagnostics', async () => {
  const success = await runBoundedChildProcess(
    process.execPath,
    ['--eval', "process.stdout.write('ok')"],
    { timeoutMs: 1_000 },
  );
  assert.deepEqual(
    {
      signal: success.signal,
      status: success.status,
      stdout: success.stdout,
      timedOut: success.timedOut,
    },
    { signal: null, status: 0, stdout: 'ok', timedOut: false },
  );

  const nonzero = await runBoundedChildProcess(
    process.execPath,
    ['--eval', 'process.exit(23)'],
    { timeoutMs: 1_000 },
  );
  assert.equal(
    describeBoundedChildFailure('probe', nonzero, 1_000),
    'probe failed (status 23)',
  );

  const absent = await runBoundedChildProcess(
    path.join(tmpdir(), `pertexo-absent-${process.pid}`),
    [],
    { timeoutMs: 1_000 },
  );
  assert.match(
    describeBoundedChildFailure('probe', absent, 1_000),
    /^probe could not start \(.+ENOENT/u,
  );
});

test('terminates and reaps a process group when a grandchild ignores TERM', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pertexo-bounded-child-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const marker = path.join(root, 'pids.json');
  const script = path.join(root, 'hang.mjs');
  await writeFile(
    script,
    `import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const child = spawn(process.execPath, ['--eval', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], { stdio: 'ignore' });
await writeFile(${JSON.stringify(marker)}, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(()=>{},1000);
`,
  );

  const startedAt = Date.now();
  const result = await runBoundedChildProcess(process.execPath, [script], {
    killGraceMs: 50,
    timeoutMs: 150,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(Date.now() - startedAt < 2_000);
  assert.match(
    describeBoundedChildFailure('hanging probe', result, 150),
    /timed out after 150ms and was reaped \(signal SIGTERM\)/u,
  );
  const pids = JSON.parse(await readFile(marker, 'utf8'));
  await Promise.all([waitForExit(pids.parent), waitForExit(pids.child)]);
});
