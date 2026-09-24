import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

import {
  acquireRunLock,
  AWS_ONLY_EXCLUSIONS,
  assertCiLocalQualityContract,
  assertQualificationEnvironment,
  createRunId,
  execute,
  LOCAL_QUALITY_COHORTS,
  parseArguments,
  reserveAvailablePorts,
  sourceIdentity,
  validateQualificationManifest,
} from './run-local-quality.mjs';
import { isolatedGitEnvironment } from '../support/git-environment.mjs';
import {
  OwnedProcessSupervisor,
  processGroupExists,
  runManagedCommand,
  terminateProcessTree,
} from '../support/owned-process-tree.mjs';
import {
  processExists,
  waitForFile,
} from '../support/test-process-observation.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('an EPERM zero-signal probe means the process group still exists', () => {
  const permissionError = Object.assign(new Error('not permitted'), {
    code: 'EPERM',
  });
  assert.equal(
    processGroupExists(12_345, () => {
      throw permissionError;
    }),
    true,
  );
});

test('current CI supplies the shared local service and specialized-suite contract', async () => {
  const source = await readFile(
    path.join(root, '.github/workflows/ci.yml'),
    'utf8',
  );
  assert.doesNotThrow(() => assertCiLocalQualityContract(source));
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace(
          'vitest.sse-resilience.config.ts',
          'missing-sse-suite.config.ts',
        ),
      ),
    /Vitest commands diverged/u,
  );
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace(
          '--exclude test/platform/compatibility-rollout.integration.test.ts',
          '--exclude test/platform/other.integration.test.ts',
        ),
      ),
    /Vitest commands diverged/u,
  );
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace(
          'pnpm --filter @pertexo/queue exec vitest run --config vitest.integration.config.ts \\',
          'pnpm --filter @pertexo/queue exec vitest run --config vitest.integration.config.ts extra.test.ts \\',
        ),
      ),
    /Vitest commands diverged/u,
  );
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace(
          'docker compose run --rm control-ledger-primary-bootstrap',
          'docker compose run --rm renamed-bootstrap',
        ),
      ),
    /service lifecycle diverged/u,
  );
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace(
          'pnpm database:coverage:merge',
          'pnpm database:coverage:changed',
        ),
      ),
    /service lifecycle diverged/u,
  );
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace('pnpm db:migrate', 'pnpm db:changed-migrate'),
      ),
    /service lifecycle diverged/u,
  );
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace(
          'docker compose up -d --wait postgres redis artifact-store control-ledger-primary control-ledger-recovery',
          'docker compose up -d --wait postgres redis',
        ),
      ),
    /service lifecycle diverged/u,
  );
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace(
          "  CONTROL_LEDGER_INTEGRATION_DEDICATED_FIXTURE: 'true'\n",
          '',
        ),
      ),
    /missing CONTROL_LEDGER_INTEGRATION_DEDICATED_FIXTURE=true/u,
  );
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace(
          "          API_SSE_RESILIENCE_DISPOSABLE_TARGET: 'true'\n",
          '',
        ),
      ),
    /missing API_SSE_RESILIENCE_DISPOSABLE_TARGET=true/u,
  );
  assert.throws(
    () =>
      assertCiLocalQualityContract(
        source.replace(
          '          API_SSE_RESILIENCE_COMPOSE_PROJECT: ${{ env.COMPOSE_PROJECT_NAME }}\n',
          '',
        ),
      ),
    /must bind API_SSE_RESILIENCE_COMPOSE_PROJECT/u,
  );
});

test('qualification rejects missing service flags that could skip tests', () => {
  assert.throws(
    () => assertQualificationEnvironment({ API_SSE_INTEGRATION: 'true' }),
    /requires .*refusing a silently skipped cohort/u,
  );
});

test('full qualification reseals provenance after every coverage writer', () => {
  const cleanup = LOCAL_QUALITY_COHORTS.find(({ id }) => id === 'cleanup');
  assert.deepEqual(cleanup?.qualificationBefore, [
    [
      process.execPath,
      'infrastructure/coverage/record-coverage-provenance.mjs',
    ],
  ]);
});

test('qualification rejects failed, skipped, and incomplete required reports', () => {
  const completeCohorts = LOCAL_QUALITY_COHORTS.map(({ id, report }) => ({
    id,
    required: true,
    reportExpected: report !== undefined,
    ...(report === undefined
      ? {}
      : {
          report: `coverage/${id}/test-results.json`,
          reportValidated: true,
          result: { passed: 1, total: 1 },
        }),
    status: 'passed',
  }));
  const complete = {
    mode: 'qualification',
    outcome: 'passed',
    source: {
      stable: true,
      started: {
        head: 'a'.repeat(40),
        fingerprint: 'b'.repeat(64),
        status: [],
      },
      completed: {
        head: 'a'.repeat(40),
        fingerprint: 'b'.repeat(64),
        status: [],
      },
    },
    cohorts: completeCohorts,
    externalExclusions: [
      ...AWS_ONLY_EXCLUSIONS.map((exclusion) => ({
        ...exclusion,
        status: 'skipped',
      })),
    ],
  };
  assert.equal(validateQualificationManifest(complete), complete);
  assert.throws(
    () =>
      validateQualificationManifest({
        ...complete,
        cohorts: complete.cohorts.map((cohort) =>
          cohort.id === 'integration-api'
            ? { ...cohort, status: 'skipped' }
            : cohort,
        ),
      }),
    /Required local cohort integration-api is skipped/u,
  );
  assert.throws(
    () =>
      validateQualificationManifest({
        ...complete,
        cohorts: complete.cohorts.map((cohort) =>
          cohort.id === 'integration-api'
            ? { ...cohort, reportValidated: false }
            : cohort,
        ),
      }),
    /has no complete report/u,
  );
  assert.throws(
    () =>
      validateQualificationManifest({
        ...complete,
        cohorts: complete.cohorts.filter(
          ({ id }) => id !== 'worker-transport-resilience',
        ),
      }),
    /must contain local cohort worker-transport-resilience exactly once/u,
  );
  assert.throws(
    () =>
      validateQualificationManifest({
        ...complete,
        cohorts: complete.cohorts.map((cohort) =>
          cohort.id === 'integration-api'
            ? { ...cohort, status: 'failed' }
            : cohort,
        ),
      }),
    /Required local cohort integration-api is failed/u,
  );
  assert.throws(
    () =>
      validateQualificationManifest({
        ...complete,
        source: { stable: false },
      }),
    /source evidence is stale/u,
  );
  for (const property of ['required', 'reportExpected'])
    assert.throws(
      () =>
        validateQualificationManifest({
          ...complete,
          cohorts: complete.cohorts.map((cohort) =>
            cohort.id === 'integration-api'
              ? { ...cohort, [property]: false }
              : cohort,
          ),
        }),
      property === 'required'
        ? /not marked required/u
        : /inconsistent report expectation/u,
    );
  assert.throws(
    () => validateQualificationManifest({ ...complete, outcome: 'failed' }),
    /outcome must be passed/u,
  );
  assert.throws(
    () =>
      validateQualificationManifest({
        ...complete,
        cohorts: [...complete.cohorts, { id: 'unknown', status: 'passed' }],
      }),
    /unknown cohort/u,
  );
  assert.throws(
    () =>
      validateQualificationManifest({
        ...complete,
        externalExclusions: [
          ...complete.externalExclusions,
          { id: 'unknown', status: 'skipped' },
        ],
      }),
    /unknown exclusion/u,
  );
});

// Fixture repositories must never inherit the caller's Git metadata: inside a
// Git hook, GIT_DIR and friends point at the real checkout.
function fixtureGit(directory, arguments_) {
  return execFileSync('git', arguments_, {
    cwd: directory,
    encoding: 'utf8',
    env: isolatedGitEnvironment(process.env),
  });
}

async function initializeTestRepository(directory, fileName, contents) {
  fixtureGit(directory, ['init', '--quiet']);
  fixtureGit(directory, ['config', 'user.name', 'Fixture Owner']);
  fixtureGit(directory, ['config', 'user.email', 'fixture@invalid.test']);
  await writeFile(path.join(directory, fileName), contents);
  fixtureGit(directory, ['add', '-A']);
  fixtureGit(directory, ['commit', '--quiet', '-m', 'test: fixture']);
}

test('source identity targets the requested checkout despite inherited Git overrides', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-source-id-'));
  const expected = path.join(directory, 'expected');
  const control = path.join(directory, 'control');
  await mkdir(expected);
  await mkdir(control);
  try {
    await initializeTestRepository(expected, 'expected.txt', 'expected\n');
    await initializeTestRepository(control, 'control.txt', 'control\n');
    const expectedHead = fixtureGit(expected, ['rev-parse', 'HEAD']).trim();
    const identity = await sourceIdentity(
      {
        ...process.env,
        GIT_DIR: path.join(control, '.git'),
        GIT_WORK_TREE: control,
        GIT_INDEX_FILE: path.join(control, 'separate-index'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'Injected Owner',
      },
      expected,
    );
    assert.equal(identity.head, expectedHead);
    assert.equal(identity.dirty, false);
    assert.deepEqual(identity.status, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('coverage lock explicitly refuses a concurrent writer and releases by owner', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-quality-lock-'));
  const lock = path.join(directory, 'quality.lock');
  const release = await acquireRunLock(lock, { token: 'first' });
  await assert.rejects(
    acquireRunLock(lock, { token: 'second' }),
    /coverage outputs are intentionally serialized/u,
  );
  await release();
  const releaseAgain = await acquireRunLock(lock, { token: 'second' });
  await releaseAgain();
});

test('coverage lock cleans up immediately when writing or closing setup fails', async () => {
  for (const failingOperation of ['write', 'close']) {
    const calls = [];
    let closeCalls = 0;
    const expected = new Error(`${failingOperation} failed`);
    await assert.rejects(
      acquireRunLock(
        '/fixture/quality.lock',
        { token: 'owner' },
        {
          mkdir: async () => calls.push('mkdir'),
          open: async () => ({
            writeFile: async () => {
              calls.push('write');
              if (failingOperation === 'write') throw expected;
            },
            close: async () => {
              closeCalls += 1;
              calls.push(`close-${String(closeCalls)}`);
              if (failingOperation === 'close' && closeCalls === 1)
                throw expected;
            },
          }),
          rm: async () => calls.push('rm'),
        },
      ),
      (error) =>
        error === expected ||
        (error instanceof AggregateError && error.errors[0] === expected),
    );
    assert.equal(calls.at(-1), 'rm');
    assert.ok(closeCalls >= 1);
  }
});

test('coverage lock release is retryable and never removes another owner', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-lock-retry-'));
  const lock = path.join(directory, 'quality.lock');
  let removeCalls = 0;
  try {
    const release = await acquireRunLock(
      lock,
      { token: 'owner' },
      {
        rm: async (file) => {
          removeCalls += 1;
          if (removeCalls === 1) throw new Error('transient remove failure');
          await rm(file);
        },
      },
    );
    await assert.rejects(release(), /transient remove failure/u);
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'owner');
    await release();
    await assert.rejects(readFile(lock), { code: 'ENOENT' });

    const guardedRelease = await acquireRunLock(lock, { token: 'original' });
    await writeFile(lock, '{"token":"replacement"}\n');
    await assert.rejects(guardedRelease(), /ownership changed/u);
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'replacement');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('service ports are dynamically allocated, unique, and releasable', async () => {
  const reservations = await reserveAvailablePorts(5);
  assert.equal(new Set(reservations.map(({ port }) => port)).size, 5);
  assert.ok(reservations.every(({ port }) => port > 0 && port < 65_536));
  await Promise.all(reservations.map(({ release }) => release()));
});

test('run identity is valid as an isolated Compose project name', () => {
  assert.match(createRunId(), /^pertexo-local-quality-[a-z0-9-]+$/u);
});

test('owned process cleanup retains ownership after a failed termination attempt', async () => {
  let attempts = 0;
  const supervisor = new OwnedProcessSupervisor(async (pid, signal) => {
    attempts += 1;
    if (attempts === 1) throw new Error('simulated termination failure');
    process.kill(pid, signal);
  });
  const child = supervisor.spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore' },
  );
  try {
    await once(child, 'spawn');
    await assert.rejects(
      supervisor.release(child),
      /simulated termination failure/u,
    );
    assert.equal(processExists(child.pid), true);
    const closed = once(child, 'close');
    await supervisor.release(child);
    await closed;
    assert.equal(processExists(child.pid), false);
    assert.equal(attempts, 2);
  } finally {
    if (child.pid && processExists(child.pid))
      await terminateProcessTree(child.pid, 'SIGKILL', 500);
  }
});

test('synchronous last-resort cleanup attempts every owned process group', async () => {
  const attempted = [];
  const supervisor = new OwnedProcessSupervisor(undefined, (pid) => {
    attempted.push(pid);
    if (attempted.length === 1) throw new Error('first group failed');
  });
  const children = [
    supervisor.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    }),
    supervisor.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    }),
  ];
  try {
    await Promise.all(children.map((child) => once(child, 'spawn')));
    assert.throws(() => supervisor.killAllSync(), /first group failed/u);
    assert.deepEqual(
      attempted,
      children.map(({ pid }) => pid),
    );
  } finally {
    await Promise.all(
      children.map((child) =>
        child.pid && processExists(child.pid)
          ? terminateProcessTree(child.pid, 'SIGKILL', 500)
          : Promise.resolve(),
      ),
    );
  }
});

test('quality command lifecycle reports spawn failure and closes its evidence log', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-quality-spawn-failure-'),
  );
  const logFile = path.join(directory, 'command.log');
  try {
    await assert.rejects(
      execute(
        `pertexo-command-that-does-not-exist-${String(process.pid)}`,
        [],
        process.env,
        logFile,
      ),
      { code: 'ENOENT' },
    );
    assert.equal(await readFile(logFile, 'utf8'), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('managed command does not mistake an undefined cleanup rejection for success', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let rejected = false;
  try {
    await runManagedCommand({
      args: [],
      command: 'synthetic-command',
      failure: () => new Error('unexpected command failure'),
      onStderr: () => undefined,
      onStdout: () => undefined,
      releaseOwned: () => Promise.reject(undefined),
      spawnOptions: {},
      spawnOwned: () => {
        setImmediate(() => {
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        });
        return child;
      },
    });
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
});

test('managed command deadline enters owned cleanup and cannot report success', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let released = 0;
  await assert.rejects(
    runManagedCommand({
      args: [],
      command: 'synthetic-command',
      failure: () => new Error('unexpected exit failure'),
      onStderr: () => undefined,
      onStdout: () => undefined,
      releaseOwned: async () => {
        released += 1;
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      },
      spawnOptions: {},
      spawnOwned: () => child,
      timeoutMillis: 5,
    }),
    /timed out after 5 ms/u,
  );
  assert.equal(released, 1);
});

test('exploratory partial runs remain explicit and reject unknown cohorts', () => {
  assert.deepEqual(parseArguments([]), {
    mode: 'qualification',
    selected: null,
  });
  const partial = parseArguments(['--partial', 'quality,integration-api']);
  assert.equal(partial.mode, 'partial');
  assert.deepEqual([...partial.selected], ['quality', 'integration-api']);
  assert.equal(parseArguments(['--', '--partial', 'quality']).mode, 'partial');
  assert.throws(
    () => parseArguments(['--partial', 'unknown']),
    /Unknown local quality cohort/u,
  );
  for (const internal of ['prerequisites', 'services', 'migration', 'cleanup'])
    assert.throws(
      () => parseArguments(['--partial', internal]),
      /internal cohort/u,
    );
  assert.ok(LOCAL_QUALITY_COHORTS.some(({ id }) => id === 'sse-resilience'));
  assert.ok(
    LOCAL_QUALITY_COHORTS.some(
      ({ id }) => id === 'worker-transport-resilience',
    ),
  );
  assert.ok(LOCAL_QUALITY_COHORTS.some(({ id }) => id === 'api-compatibility'));
  assert.ok(LOCAL_QUALITY_COHORTS.some(({ id }) => id === 'performance'));
});

for (const signal of ['SIGINT', 'SIGTERM'])
  test(`interrupting an active workload with ${signal} terminates its process tree`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-quality-tree-'),
    );
    const executable = path.join(directory, 'pnpm');
    const nestedPidFile = path.join(directory, 'nested.pid');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
if (process.argv[2] === '--version') {
  process.stdout.write('11.22.0\\n');
  process.exit(0);
}
const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});
writeFileSync(process.env.PERTEXO_TEST_NESTED_PID, String(nested.pid));
setInterval(() => {}, 1000);
`,
    );
    await chmod(executable, 0o755);
    const runner = spawn(
      process.execPath,
      ['infrastructure/quality/run-local-quality.mjs', '--partial', 'quality'],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          PERTEXO_LOCAL_QUALITY_TEST_STATE_DIRECTORY: path.join(
            directory,
            'state',
          ),
          PERTEXO_TEST_NESTED_PID: nestedPidFile,
        },
        stdio: 'ignore',
      },
    );
    let nestedPid;
    try {
      nestedPid = Number(await waitForFile(nestedPidFile));
      assert.equal(processExists(nestedPid), true);
      runner.kill(signal);
      const [code, closeSignal] = await once(runner, 'close');
      assert.equal(code, 130);
      assert.equal(closeSignal, null);
      await delay(100);
      assert.equal(processExists(nestedPid), false);
      assert.equal(
        (await readdir(path.join(directory, 'state', 'local-quality'))).length,
        1,
      );
      await assert.rejects(
        readFile(path.join(directory, 'state', '.local-quality.lock')),
        { code: 'ENOENT' },
      );
    } finally {
      if (runner.exitCode === null && runner.signalCode === null)
        runner.kill('SIGKILL');
      if (nestedPid && processExists(nestedPid))
        process.kill(nestedPid, 'SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

for (const signal of ['SIGINT', 'SIGTERM'])
  test(`interrupting a prerequisite with ${signal} terminates its process tree`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-quality-capture-'),
    );
    const executable = path.join(directory, 'pnpm');
    const nestedPidFile = path.join(directory, 'nested.pid');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.env.PERTEXO_TEST_NESTED_PID, String(nested.pid));
setInterval(() => {}, 1000);
`,
    );
    await chmod(executable, 0o755);
    const runner = spawn(
      process.execPath,
      ['infrastructure/quality/run-local-quality.mjs', '--partial', 'quality'],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          PERTEXO_LOCAL_QUALITY_TEST_STATE_DIRECTORY: path.join(
            directory,
            'state',
          ),
          PERTEXO_TEST_NESTED_PID: nestedPidFile,
        },
        stdio: 'ignore',
      },
    );
    let nestedPid;
    try {
      nestedPid = Number(await waitForFile(nestedPidFile));
      runner.kill(signal);
      await once(runner, 'close');
      await delay(100);
      assert.equal(processExists(nestedPid), false);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null)
        runner.kill('SIGKILL');
      if (nestedPid && processExists(nestedPid))
        process.kill(nestedPid, 'SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

test('a failed command cannot orphan its nested workload', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-quality-failure-'),
  );
  const executable = path.join(directory, 'pnpm');
  const nestedPidFile = path.join(directory, 'nested.pid');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
if (process.argv[2] === '--version') process.exit(0);
const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
writeFileSync(process.env.PERTEXO_TEST_NESTED_PID, String(nested.pid));
process.exit(9);
`,
  );
  await chmod(executable, 0o755);
  const runner = spawn(
    process.execPath,
    ['infrastructure/quality/run-local-quality.mjs', '--partial', 'quality'],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        PERTEXO_LOCAL_QUALITY_TEST_STATE_DIRECTORY: path.join(
          directory,
          'state',
        ),
        PERTEXO_TEST_NESTED_PID: nestedPidFile,
      },
      stdio: 'ignore',
    },
  );
  let nestedPid;
  try {
    nestedPid = Number(await waitForFile(nestedPidFile));
    const [code] = await Promise.race([
      once(runner, 'close'),
      delay(2_000, undefined, { ref: false }).then(() => {
        throw new Error('quality runner hung on inherited output pipes');
      }),
    ]);
    assert.equal(code, 1);
    await delay(100);
    assert.equal(processExists(nestedPid), false);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null)
      runner.kill('SIGKILL');
    if (nestedPid && processExists(nestedPid))
      process.kill(nestedPid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('cleanup failure cannot leave inherited output pipes blocking the runner', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-quality-cleanup-failure-'),
  );
  const nestedPidFile = path.join(directory, 'nested.pid');
  const logFile = path.join(directory, 'command.log');
  let nestedPid;
  try {
    const execution = execute(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
writeFileSync(process.env.PERTEXO_TEST_NESTED_PID, String(nested.pid));
process.exit(9);`,
      ],
      { ...process.env, PERTEXO_TEST_NESTED_PID: nestedPidFile },
      logFile,
      {
        spawnOwned: (command, arguments_, options) =>
          spawn(command, arguments_, { ...options, detached: true }),
        releaseOwned: () => Promise.reject(new Error('termination failed')),
        requestTermination: () => undefined,
      },
    ).then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    );
    nestedPid = Number(await waitForFile(nestedPidFile));
    const result = await Promise.race([
      execution,
      delay(2_000, undefined, { ref: false }).then(() => ({
        error: new Error('cleanup failure remained hidden behind pipe close'),
      })),
    ]);
    assert(result.error instanceof AggregateError);
    assert(
      result.error.errors.some((error) =>
        /termination failed/u.test(String(error)),
      ),
    );
  } finally {
    if (nestedPid && processExists(nestedPid))
      process.kill(nestedPid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('a log failure during final drain fails the command evidence', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-quality-log-failure-'),
  );
  try {
    await assert.rejects(
      execute(
        process.execPath,
        ['-e', 'process.exit(0)'],
        process.env,
        path.join(directory, 'unused.log'),
        {
          createLogStream: () =>
            new Writable({
              write(_chunk, _encoding, callback) {
                callback();
              },
              final(callback) {
                callback(new Error('late log failure'));
              },
            }),
        },
      ),
      /late log failure/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('command output pauses owned streams until every required sink drains', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-quality-backpressure-'),
  );
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let pauses = 0;
  let resumes = 0;
  const pause = child.stdout.pause.bind(child.stdout);
  const resume = child.stdout.resume.bind(child.stdout);
  child.stdout.pause = () => {
    pauses += 1;
    return pause();
  };
  child.stdout.resume = () => {
    resumes += 1;
    return resume();
  };
  const logChunks = [];
  const stdoutChunks = [];
  const slowWritable = (chunks) =>
    new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        setTimeout(callback, 15);
      },
    });
  try {
    const execution = execute(
      'synthetic-command',
      [],
      process.env,
      path.join(directory, 'unused.log'),
      {
        createLogStream: () => slowWritable(logChunks),
        stdout: slowWritable(stdoutChunks),
        stderr: slowWritable([]),
        spawnOwned: () => {
          setImmediate(() => {
            child.stdout.write('first');
            child.stdout.end('second');
            child.stderr.end();
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
          });
          return child;
        },
        releaseOwned: () => Promise.resolve(),
        requestTermination: () => undefined,
      },
    );
    await execution;
    assert.equal(logChunks.join(''), 'firstsecond');
    assert.equal(stdoutChunks.join(''), 'firstsecond');
    assert.ok(pauses >= 1);
    assert.ok(resumes >= 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed command drains output delivered after exit before close', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-quality-tail-log-'),
  );
  const logFile = path.join(directory, 'command.log');
  try {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const execution = execute('synthetic-command', [], process.env, logFile, {
      spawnOwned: () => {
        setImmediate(() => {
          child.emit('exit', 9, null);
          setImmediate(() => {
            child.stdout.end('TAIL-AFTER-EXIT');
            child.stderr.end();
            child.emit('close', 9, null);
          });
        });
        return child;
      },
      releaseOwned: () => Promise.resolve(),
      requestTermination: () => undefined,
    });

    await assert.rejects(execution, /failed with exit 9/u);
    assert.equal(await readFile(logFile, 'utf8'), 'TAIL-AFTER-EXIT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const outputName of ['stdout', 'stderr'])
  test(`managed command rejects an ${outputName} stream error without letting it escape`, async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const expected = new Error(`${outputName} stream failed`);
    const execution = runManagedCommand({
      args: [],
      command: 'synthetic-command',
      failure: (code) =>
        new Error(`synthetic-command failed with ${String(code)}`),
      onStderr: () => undefined,
      onStdout: () => undefined,
      releaseOwned: () => Promise.resolve(),
      spawnOptions: {},
      spawnOwned: () => child,
    });

    let escaped;
    try {
      child[outputName].emit('error', expected);
      child[outputName].emit('error', new Error('repeated stream failure'));
    } catch (error) {
      escaped = error;
    }
    child.emit('exit', 0, null);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);

    assert.equal(escaped, undefined);
    await assert.rejects(execution, expected);
  });
