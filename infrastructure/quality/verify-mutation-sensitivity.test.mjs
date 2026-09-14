import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  MUTATIONS,
  copyMutationCandidate,
  initializeSnapshotRepository,
  runMutationCommand,
  validateMutationDefinitions,
} from './verify-mutation-sensitivity.mjs';
import { preserveTemporaryDirectoryFailure } from '../support/temporary-directory-cleanup.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('every N09 mutation has one exact site and an owning command', async () => {
  assert.equal(validateMutationDefinitions(), MUTATIONS);
  assert.equal(MUTATIONS.length, 7);
  for (const mutation of MUTATIONS) {
    const source = await readFile(path.join(root, mutation.file), 'utf8');
    assert.equal(
      source.split(mutation.search).length - 1,
      1,
      `${mutation.id} must resolve exactly once`,
    );
    assert.notEqual(
      mutation.expectedFailure.source,
      mutation.expectedFailureDetail.source,
      `${mutation.id} must require a failure diagnostic beyond its title`,
    );
  }
});

test('covers provider truth, both control entries, both CLIs, fences, duplicates and evidence compatibility', () => {
  const ids = MUTATIONS.map(({ id }) => id).join(' ');
  for (const expected of [
    'transient-provider',
    'prior-dispatch-control',
    'quality-cli',
    'benchmark-cli',
    'stale-attempt-fence',
    'inbox-duplicate',
    'incompatible-benchmark',
  ])
    assert.match(ids, new RegExp(expected, 'u'));
});

test('preserves primary and temporary-directory cleanup failures', async () => {
  const primary = new Error('validation failed');
  const cleanup = new Error('temporary directory removal failed');

  await assert.rejects(
    preserveTemporaryDirectoryFailure({ error: primary, failed: true }, () =>
      Promise.reject(cleanup),
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    },
  );
});

test('normalizes a sole non-Error temporary-directory cleanup failure', async () => {
  await assert.rejects(
    preserveTemporaryDirectoryFailure({ error: undefined, failed: false }, () =>
      Promise.reject('cleanup rejected'),
    ),
    (error) => {
      assert(error instanceof Error);
      assert.equal(error.message, 'Temporary-directory cleanup failed');
      assert.equal(error.cause, 'cleanup rejected');
      return true;
    },
  );
});

function git(directory, arguments_) {
  return execFileSync('git', arguments_, { cwd: directory, encoding: 'utf8' });
}

test('snapshot Git setup cannot mutate an inherited control repository', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-mutation-git-isolation-'),
  );
  const control = path.join(directory, 'control');
  const snapshot = path.join(directory, 'snapshot');
  await mkdir(control);
  await mkdir(snapshot);
  try {
    git(control, ['init', '--quiet']);
    git(control, ['config', 'user.name', 'Control Owner']);
    git(control, ['config', 'user.email', 'control@invalid.test']);
    await writeFile(path.join(control, 'sentinel.txt'), 'sentinel\n');
    git(control, ['add', '-A']);
    git(control, ['commit', '--quiet', '-m', 'test: control sentinel']);
    await writeFile(path.join(snapshot, 'candidate.txt'), 'candidate\n');

    const controlHead = git(control, ['rev-parse', 'HEAD']).trim();
    const controlIndex = await readFile(path.join(control, '.git', 'index'));
    const controlConfig = await readFile(path.join(control, '.git', 'config'));
    const separateIndex = path.join(control, 'separate-index');
    await writeFile(separateIndex, controlIndex);
    const separateIndexBefore = await readFile(separateIndex);
    const controlStatusBefore = git(control, ['status', '--porcelain']);

    await initializeSnapshotRepository(snapshot, {
      ...process.env,
      GIT_DIR: path.join(control, '.git'),
      GIT_WORK_TREE: control,
      GIT_INDEX_FILE: separateIndex,
      GIT_COMMON_DIR: path.join(control, '.git'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Injected Owner',
    });

    assert.equal(git(control, ['rev-parse', 'HEAD']).trim(), controlHead);
    assert.deepEqual(
      await readFile(path.join(control, '.git', 'index')),
      controlIndex,
    );
    assert.deepEqual(
      await readFile(path.join(control, '.git', 'config')),
      controlConfig,
    );
    assert.deepEqual(await readFile(separateIndex), separateIndexBefore);
    assert.equal(git(control, ['status', '--porcelain']), controlStatusBefore);
    assert.equal(
      git(snapshot, ['log', '-1', '--pretty=%s']).trim(),
      'test: snapshot mutation candidate',
    );
    assert.equal(
      git(snapshot, ['config', 'user.name']).trim(),
      'Pertexo mutation verifier',
    );
    assert.equal(git(snapshot, ['status', '--porcelain']), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('candidate enumeration targets its source repository under Git overrides', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-mutation-source-isolation-'),
  );
  const source = path.join(directory, 'source');
  const control = path.join(directory, 'control');
  const snapshot = path.join(directory, 'snapshot');
  await Promise.all([mkdir(source), mkdir(control), mkdir(snapshot)]);
  try {
    git(source, ['init', '--quiet']);
    git(source, ['config', 'user.name', 'Source Owner']);
    git(source, ['config', 'user.email', 'source@invalid.test']);
    await writeFile(path.join(source, 'source.txt'), 'source\n');
    git(source, ['add', '-A']);
    git(source, ['commit', '--quiet', '-m', 'test: source']);
    git(control, ['init', '--quiet']);
    git(control, ['config', 'user.name', 'Control Owner']);
    git(control, ['config', 'user.email', 'control@invalid.test']);
    await writeFile(path.join(control, 'control.txt'), 'control\n');
    git(control, ['add', '-A']);
    git(control, ['commit', '--quiet', '-m', 'test: control']);

    await copyMutationCandidate(snapshot, source, {
      ...process.env,
      GIT_DIR: path.join(control, '.git'),
      GIT_WORK_TREE: control,
      GIT_INDEX_FILE: path.join(control, '.git', 'index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Injected Owner',
    });

    assert.equal(
      await readFile(path.join(snapshot, 'source.txt'), 'utf8'),
      'source\n',
    );
    await assert.rejects(readFile(path.join(snapshot, 'control.txt')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function delayedSuccessfulSupervisor({ failFirstTermination = false } = {}) {
  let terminationCalls = 0;
  return {
    get terminationCalls() {
      return terminationCalls;
    },
    spawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setTimeout(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      }, 20);
      return child;
    },
    release: () => Promise.resolve(),
    async terminateAll() {
      terminationCalls += 1;
      if (failFirstTermination && terminationCalls === 1)
        throw new Error('simulated timeout termination failure');
    },
  };
}

test('mutation command cannot report success after its deadline fires', async () => {
  const supervisor = delayedSuccessfulSupervisor();
  await assert.rejects(
    runMutationCommand('synthetic-command', [], root, 5, process.env, {
      supervisor,
    }),
    /timed out after 5 ms/u,
  );
  assert.equal(supervisor.terminationCalls, 2);
});

test('mutation timeout preserves failed termination and retries owned cleanup', async () => {
  const supervisor = delayedSuccessfulSupervisor({
    failFirstTermination: true,
  });
  await assert.rejects(
    runMutationCommand('synthetic-command', [], root, 5, process.env, {
      supervisor,
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.message, /timed out and cleanup failed/u);
      assert.match(String(error.errors[0]), /timed out after 5 ms/u);
      assert.match(
        String(error.errors[1]),
        /simulated timeout termination failure/u,
      );
      return true;
    },
  );
  assert.equal(supervisor.terminationCalls, 2);
});
