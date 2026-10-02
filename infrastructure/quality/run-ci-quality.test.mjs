import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CI_QUALITY_SCRIPTS,
  parseCiQualityArguments,
  runCiQuality,
} from './run-ci-quality.mjs';

const argumentsForCi = [
  '--quality',
  ...CI_QUALITY_SCRIPTS,
  '--contracts',
  'quality:local:check',
];
const runnerPath = fileURLToPath(
  new URL('./run-ci-quality.mjs', import.meta.url),
);

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pertexo-ci-quality-'));
  try {
    const eventsPath = path.join(root, 'events.jsonl');
    const executable = path.join(root, 'pnpm');
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
const script = process.argv[2];
const eventsPath = process.env.CI_TEST_EVENTS;
const record = async (phase) => appendFile(eventsPath, JSON.stringify({ script, phase, pid: process.pid }) + '\\n');
await record('start');
if (process.env.CI_TEST_LEAVE_DESCENDANT === 'true') {
  const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  nested.unref();
  await appendFile(eventsPath, JSON.stringify({ script, phase: 'nested', pid: nested.pid }) + '\\n');
}
if (process.env.CI_TEST_FLOOD === 'true') {
  await record('flood');
  for (let index = 0; index < 128; index++)
    if (!process.stdout.write(Buffer.alloc(32768, 'x'))) await once(process.stdout, 'drain');
}
if (process.env.CI_TEST_HOLD === 'true') {
  const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  await appendFile(eventsPath, JSON.stringify({ script, phase: 'nested', pid: nested.pid }) + '\\n');
  await new Promise(() => setInterval(() => {}, 1000));
}
if (script === 'docs:check' && process.env.CI_TEST_BARRIER === 'true') {
  const deadline = Date.now() + 2000;
  while (!(await readFile(eventsPath, 'utf8')).includes('quality:local:check')) {
    if (Date.now() > deadline) throw new Error('contract lane did not overlap');
    await delay(5);
  }
}
if (script === 'quality:local:check') await delay(80);
process.stdout.write('final-output-' + script + '\\n');
process.stderr.write('final-error-output-' + script + '\\n');
await record('end');
if ((process.env.CI_TEST_FAILURES ?? '').split(',').includes(script)) process.exitCode = 7;
`,
    );
    await chmod(executable, 0o755);
    const env = {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      CI_TEST_EVENTS: eventsPath,
    };
    const events = async () =>
      (await readFile(eventsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    await run({ root, env, events });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the CLI accepts only the complete fixed gate inventory and lane order', () => {
  assert.deepEqual(parseCiQualityArguments(argumentsForCi), [
    CI_QUALITY_SCRIPTS,
    ['quality:local:check'],
  ]);
  for (const index of argumentsForCi.keys()) {
    assert.throws(
      () =>
        parseCiQualityArguments(
          argumentsForCi.filter((_, candidate) => candidate !== index),
        ),
      /exactly once/u,
    );
  }
  assert.throws(
    () => parseCiQualityArguments([...argumentsForCi, 'lint']),
    /exactly once/u,
  );
  assert.throws(
    () =>
      parseCiQualityArguments([
        '--quality',
        'unknown',
        ...argumentsForCi.slice(1),
      ]),
    /exactly once/u,
  );
});

test('joins overlapping lanes while retaining serial exactly-once quality commands', async () => {
  await withFixture(async ({ root, env, events }) => {
    await runCiQuality(argumentsForCi, {
      cwd: root,
      env: { ...env, CI_TEST_BARRIER: 'true' },
    });
    const actual = await events();
    assert.deepEqual(
      actual
        .filter(
          (event) =>
            event.phase === 'start' && event.script !== 'quality:local:check',
        )
        .map((event) => event.script),
      CI_QUALITY_SCRIPTS,
    );
    assert.equal(
      actual.filter(
        (event) =>
          event.script === 'quality:local:check' && event.phase === 'start',
      ).length,
      1,
    );
    assert.ok(
      actual.findIndex(
        (event) =>
          event.script === 'quality:local:check' && event.phase === 'start',
      ) <
        actual.findIndex(
          (event) => event.script === 'docs:check' && event.phase === 'end',
        ),
    );
    for (const script of [...CI_QUALITY_SCRIPTS, 'quality:local:check'])
      assert.equal(
        actual.filter(
          (event) => event.script === script && event.phase === 'end',
        ).length,
        1,
      );
    for (let index = 1; index < CI_QUALITY_SCRIPTS.length; index++)
      assert.ok(
        actual.findIndex(
          (event) =>
            event.script === CI_QUALITY_SCRIPTS[index - 1] &&
            event.phase === 'end',
        ) <
          actual.findIndex(
            (event) =>
              event.script === CI_QUALITY_SCRIPTS[index] &&
              event.phase === 'start',
          ),
      );
  });
});

for (const failed of [
  'docs:check',
  'quality:local:check',
  'docs:check,quality:local:check',
])
  test(`joins both lanes and propagates failures from ${failed}`, async () => {
    await withFixture(async ({ root, env, events }) => {
      await assert.rejects(
        runCiQuality(argumentsForCi, {
          cwd: root,
          env: { ...env, CI_TEST_FAILURES: failed },
        }),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, failed.split(',').length);
          for (const script of failed.split(','))
            assert.ok(
              error.errors.some((failure) => failure.message.includes(script)),
            );
          return true;
        },
      );
      const actual = await events();
      assert.equal(
        actual.filter(
          (event) =>
            event.script === 'quality:local:check' && event.phase === 'end',
        ).length,
        1,
      );
      assert.equal(
        actual.filter(
          (event) =>
            event.script ===
              (failed.includes('docs:check') ? 'docs:check' : 'typecheck') &&
            event.phase === 'end',
        ).length,
        1,
      );
      if (failed.includes('docs:check'))
        assert.ok(!actual.some((event) => event.script === 'format:check'));
    });
  });

test('an already-aborted lane starts no child command', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before start'));
  let spawnCount = 0;
  await assert.rejects(
    runCiQuality(argumentsForCi, {
      signal: controller.signal,
      supervisor: {
        spawn() {
          spawnCount++;
        },
        release() {
          throw new Error('No child can be released before start');
        },
        async terminateAll() {
          return undefined;
        },
      },
    }),
    AggregateError,
  );
  assert.equal(spawnCount, 0);
});

test('cancellation joins and removes only both owned descendant trees', async () => {
  await withFixture(async ({ root, env, events }) => {
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    const closed = new Promise((resolve) => unrelated.once('close', resolve));
    const controller = new AbortController();
    const running = runCiQuality(argumentsForCi, {
      cwd: root,
      env: { ...env, CI_TEST_HOLD: 'true' },
      signal: controller.signal,
    });
    const rejected = assert.rejects(running, AggregateError);
    try {
      const deadline = Date.now() + 5000;
      let actual = [];
      while (actual.filter((event) => event.phase === 'nested').length < 2) {
        assert.ok(Date.now() < deadline, 'both lanes must start');
        await delay(10);
        actual = await events().catch(() => []);
      }
      controller.abort(new Error('cancel both lanes'));
      await rejected;
      for (const pid of new Set(actual.map((event) => event.pid)))
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
      assert.ok(
        !(await events()).some((event) => event.script === 'format:check'),
      );
    } finally {
      controller.abort();
      await rejected;
      unrelated.kill();
      await closed;
    }
  });
});

for (const [terminationSignal, expectedCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  test(`the actual CLI cleans both lanes and preserves ${terminationSignal} exit status`, async () => {
    await withFixture(async ({ env, events }) => {
      const runner = spawn(process.execPath, [runnerPath, ...argumentsForCi], {
        env: { ...env, CI_TEST_HOLD: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      runner.stdout.resume();
      runner.stderr.resume();
      const closed = once(runner, 'close');
      try {
        let actual = [];
        const deadline = Date.now() + 5000;
        while (actual.filter((event) => event.phase === 'nested').length < 2) {
          assert.ok(Date.now() < deadline, 'both actual CLI lanes must start');
          await delay(10);
          actual = await events().catch(() => []);
        }
        runner.kill(terminationSignal);
        assert.deepEqual(await closed, [expectedCode, null]);
        for (const pid of new Set(actual.map((event) => event.pid)))
          assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally {
        if (runner.exitCode === null && runner.signalCode === null)
          runner.kill('SIGKILL');
        await closed;
      }
    });
  });

test('the actual CLI drains stdout and stderr from both failed lanes before exit', async () => {
  await withFixture(async ({ env, events }) => {
    const runner = spawn(process.execPath, [runnerPath, ...argumentsForCi], {
      env: { ...env, CI_TEST_FAILURES: 'docs:check,quality:local:check' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    runner.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    runner.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    assert.deepEqual(await once(runner, 'close'), [1, null]);
    for (const script of ['docs:check', 'quality:local:check']) {
      assert.ok(stdout.includes(`final-output-${script}`));
      assert.ok(stderr.includes(`final-error-output-${script}`));
      assert.ok(stderr.includes(`CI quality gate ${script} failed`));
      assert.equal(
        (await events()).filter(
          (event) => event.script === script && event.phase === 'end',
        ).length,
        1,
      );
    }
  });
});

test('the actual CLI retains downstream backpressure without buffering both lanes', async () => {
  await withFixture(async ({ env, events }) => {
    const runner = spawn(process.execPath, [runnerPath, ...argumentsForCi], {
      env: { ...env, CI_TEST_FLOOD: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runner.stderr.resume();
    const closed = once(runner, 'close');
    try {
      let actual = [];
      const deadline = Date.now() + 5000;
      while (actual.filter((event) => event.phase === 'flood').length < 2) {
        assert.ok(Date.now() < deadline, 'both output producers must start');
        await delay(10);
        actual = await events().catch(() => []);
      }
      // No stdout reader exists yet. Two 4 MiB producers must remain blocked
      // behind the bounded OS/readable buffers rather than queue in the owner.
      await delay(200);
      assert.ok(!(await events()).some((event) => event.phase === 'end'));
      runner.stdout.resume();
      assert.deepEqual(await closed, [0, null]);
      assert.equal(
        (await events()).filter((event) => event.phase === 'end').length,
        12,
      );
    } finally {
      runner.stdout.resume();
      if (runner.exitCode === null && runner.signalCode === null)
        runner.kill('SIGTERM');
      await closed;
    }
  });
});

for (const failSyncFallback of [false, true])
  test(`the actual CLI retries retained owned cleanup after async teardown failure (sync failure: ${String(failSyncFallback)})`, async () => {
    await withFixture(async ({ root, env, events }) => {
      const fixtureRoot = await realpath(root);
      const injectedRunner = path.join(
        fixtureRoot,
        'infrastructure/quality/run-ci-quality.mjs',
      );
      const injectedSupervisor = path.join(
        fixtureRoot,
        'infrastructure/support/owned-process-tree.mjs',
      );
      await mkdir(path.dirname(injectedRunner), { recursive: true });
      await mkdir(path.dirname(injectedSupervisor), { recursive: true });
      const productionEntrypoint = await readFile(runnerPath, 'utf8');
      await writeFile(injectedRunner, productionEntrypoint);
      assert.equal(
        await readFile(injectedRunner, 'utf8'),
        productionEntrypoint,
      );
      const productionSupervisorUrl = new URL(
        '../support/owned-process-tree.mjs',
        import.meta.url,
      ).href;
      // Only this owned fixture's adapter fails asynchronous termination. The
      // copied CLI and actual synchronous owned-group fallback remain real.
      await writeFile(
        injectedSupervisor,
        `
import { appendFileSync } from 'node:fs';
import { OwnedProcessSupervisor as ProductionSupervisor, runManagedCommand } from ${JSON.stringify(productionSupervisorUrl)};
export { runManagedCommand };
export class OwnedProcessSupervisor extends ProductionSupervisor {
  #attempts = 0;
  constructor() { super(async () => { throw new Error('injected asynchronous cleanup failure'); }); }
  killAllSync() {
    this.#attempts++;
    appendFileSync(process.env.CI_TEST_EVENTS, JSON.stringify({ phase: 'fallback', attempt: this.#attempts }) + '\\n');
    super.killAllSync();
    if (${String(failSyncFallback)} && this.#attempts === 1) throw new Error('injected synchronous fallback failure');
  }
}
`,
      );
      const unrelated = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: 'ignore' },
      );
      const unrelatedClosed = once(unrelated, 'close');
      const runner = spawn(
        process.execPath,
        [injectedRunner, ...argumentsForCi],
        {
          env: { ...env, CI_TEST_LEAVE_DESCENDANT: 'true' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      runner.stdout.resume();
      let stderr = '';
      runner.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const exited = once(runner, 'exit');
      const closed = once(runner, 'close');
      let descendants = [];
      try {
        assert.deepEqual(await exited, [1, null]);
        descendants = (await events())
          .filter((event) => event.phase === 'nested')
          .map((event) => event.pid);
        assert.equal(descendants.length, 2);
        await delay(50);
        for (const pid of descendants)
          assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
        await closed;
        assert.ok(stderr.includes('injected asynchronous cleanup failure'));
        assert.ok((await events()).some((event) => event.phase === 'fallback'));
        if (failSyncFallback) {
          assert.ok(stderr.includes('injected synchronous fallback failure'));
          assert.ok(
            stderr.includes('CI quality failed with emergency cleanup failure'),
          );
        }
      } finally {
        descendants = (await events().catch(() => []))
          .filter((event) => event.phase === 'nested')
          .map((event) => event.pid);
        for (const pid of descendants) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            assert.equal(error.code, 'ESRCH');
          }
        }
        if (runner.exitCode === null && runner.signalCode === null)
          runner.kill('SIGKILL');
        await closed;
        unrelated.kill();
        await unrelatedClosed;
      }
    });
  });
