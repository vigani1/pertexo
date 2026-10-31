import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const { services } = parse(
  readFileSync(join(root, 'infrastructure/single-server/compose.yaml'), 'utf8'),
  { merge: true },
);
const ecsCheck = JSON.parse(
  readFileSync(join(root, 'infrastructure/ecs/workloads.json'), 'utf8'),
).workloads.worker.healthCheck[1];
const composeCheck = services.worker.healthcheck.test[1].replaceAll('$$', '$');

/**
 * Runs the real command against a stand-in worker, in a directory of its own. PID
 * 1 is pointed at this shell: outside a container it isn't ours to signal.
 */
function runCheck(t, check, marks) {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-worker-health-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const worker = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => worker.kill('SIGKILL'));
  const exited = new Promise((done) => {
    worker.once('exit', () => {
      done(true);
    });
  });
  const path = (name) => join(directory, name);
  if (marks.ready) writeFileSync(path('pertexo-worker-ready'), '');
  if (marks.revoked) writeFileSync(path('pertexo-worker-not-ready'), '');
  if (marks.progressAgeMinutes !== undefined) {
    writeFileSync(path('pertexo-worker-progress'), String(worker.pid));
    const at = Date.now() / 1_000 - marks.progressAgeMinutes * 60;
    utimesSync(path('pertexo-worker-progress'), at, at);
  }
  const { status } = spawnSync(
    'sh',
    [
      '-c',
      check
        .replaceAll('/tmp/', `${directory}/`)
        .replace('kill -0 1', () => 'kill -0 $$'),
    ],
    { stdio: 'ignore' },
  );
  return { status, exited };
}

const stoppedWithin = (exited, millis) =>
  Promise.race([
    exited,
    new Promise((done) => {
      setTimeout(() => {
        done(false);
      }, millis).unref();
    }),
  ]);

for (const [name, check] of [
  ['compose', composeCheck],
  ['ecs', ecsCheck],
]) {
  test(`${name}: a worker making progress is healthy and left alone`, async (t) => {
    const { status, exited } = runCheck(t, check, {
      ready: true,
      progressAgeMinutes: 1,
    });
    assert.equal(status, 0);
    assert.equal(await stoppedWithin(exited, 200), false);
  });

  test(`${name}: a worker with no progress for 5 minutes fails and is ended`, async (t) => {
    const { status, exited } = runCheck(t, check, {
      ready: true,
      progressAgeMinutes: 6,
    });
    assert.notEqual(status, 0);
    assert.equal(await stoppedWithin(exited, 2_000), true);
  });

  test(`${name}: a worker still starting is not ended, however old its files`, async (t) => {
    const { status, exited } = runCheck(t, check, { progressAgeMinutes: 6 });
    assert.notEqual(status, 0);
    assert.equal(await stoppedWithin(exited, 200), false);
  });

  test(`${name}: a worker that reports not ready is unhealthy, and not ended`, async (t) => {
    const { status, exited } = runCheck(t, check, {
      ready: true,
      revoked: true,
      progressAgeMinutes: 1,
    });
    assert.notEqual(status, 0);
    assert.equal(await stoppedWithin(exited, 200), false);
  });
}

// Docker never restarts for `unhealthy`, so ending the worker has to reach it.
test('compose: a killed worker comes back, and node is not PID 1', () => {
  assert.equal(services.worker.init, true);
  assert.equal(services.worker.restart, 'unless-stopped');
  assert.match(services.worker.command[2], /^rm -f [^;]*progress;/u);
});
