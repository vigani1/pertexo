#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import {
  OwnedProcessSupervisor,
  runManagedCommand,
} from './owned-process-tree.mjs';
import { isolatedGitEnvironment } from './git-environment.mjs';
import { preserveTemporaryDirectoryFailure } from './temporary-directory-cleanup.mjs';

const root = path.resolve(import.meta.dirname, '..');

const workerIntegration = [
  '--filter',
  '@pertexo/worker',
  'exec',
  'vitest',
  'run',
  '--config',
  'vitest.integration.config.ts',
  'test/http-node-attempt.integration.test.ts',
];

export const MUTATIONS = Object.freeze([
  Object.freeze({
    id: 'transient-provider-remapped-internal',
    file: 'packages/integrations/src/http-request/executor.ts',
    search: `throw new HttpRequestExecutorError(
      Object.freeze({
        kind: 'retry',
        errorKind: 'provider',
        reuseProviderKey: false,
      }),
      false,
    );`,
    replacement: `throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'internal' }),
      false,
    );`,
    prepare: ['pnpm', '--filter', '@pertexo/integrations', 'build'],
    command: [
      'pnpm',
      ...workerIntegration,
      '-t',
      'persists a transient HTTP credential-resolution failure',
    ],
    expectedFailure: /persists a transient HTTP credential-resolution failure/u,
    expectedFailureDetail: /executor_error_kind|executor_failure_kind/u,
  }),
  Object.freeze({
    id: 'discard-prior-dispatch-control-uncertainty',
    file: 'apps/worker/src/execution/node-attempt-handler.ts',
    search: 'return lease.providerDispatchUnresolved === true || dispatched;',
    replacement: 'return dispatched;',
    command: [
      'pnpm',
      '--filter',
      '@pertexo/worker',
      'exec',
      'vitest',
      'run',
      'test/node-attempt-outcomes.test.ts',
      '-t',
      'preserves prior dispatch uncertainty',
    ],
    expectedFailure: /preserves prior dispatch uncertainty/u,
    expectedFailureDetail: /execution\.outcome_unknown/u,
  }),
  Object.freeze({
    id: 'quality-cli-close-before-cleanup',
    file: 'infrastructure/owned-process-tree.mjs',
    search: '  try {\n    await releaseOwned(child);',
    replacement: '  try {\n    await closed;\n    await releaseOwned(child);',
    command: [
      process.execPath,
      '--test',
      '--test-name-pattern=a failed command cannot orphan its nested workload',
      'infrastructure/run-local-quality.test.mjs',
    ],
    expectedFailure: /failed command cannot orphan its nested workload/u,
    expectedFailureDetail: /quality runner hung on inherited output pipes/u,
  }),
  Object.freeze({
    id: 'benchmark-cli-close-before-cleanup',
    file: 'infrastructure/owned-process-tree.mjs',
    search: '  try {\n    await releaseOwned(child);',
    replacement: '  try {\n    await closed;\n    await releaseOwned(child);',
    command: [
      process.execPath,
      '--test',
      '--test-name-pattern=a failed benchmark command cannot hang on output pipes inherited by a descendant',
      'infrastructure/performance/run-local-benchmark.test.mjs',
    ],
    expectedFailure:
      /failed benchmark command cannot hang on output pipes inherited by a descendant/u,
    expectedFailureDetail: /benchmark runner hung on inherited output pipes/u,
  }),
  Object.freeze({
    id: 'remove-stale-attempt-fence',
    file: 'packages/database/src/execution/node-attempt-run-store-outcomes.ts',
    search: '    Number(row.fence_token) !== input.lease.fenceToken ||\n',
    replacement: '',
    prepare: ['pnpm', '--filter', '@pertexo/database', 'build'],
    command: [
      'pnpm',
      '--filter',
      '@pertexo/database',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      'test/coordinator-run-store-node-attempts.integration.test.ts',
      '-t',
      'rejects completion when only the durable attempt fence is stale',
    ],
    expectedFailure:
      /rejects completion when only the durable attempt fence is stale/u,
    expectedFailureDetail: /instead of rejecting|promise resolved/u,
  }),
  Object.freeze({
    id: 'remove-inbox-duplicate-branch',
    file: 'packages/database/src/execution/inbox.ts',
    search: '      if (inserted.length === 0) {',
    replacement: '      if (inserted.length < 0) {',
    command: [
      'pnpm',
      '--filter',
      '@pertexo/database',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      'test/transport.integration.test.ts',
      '-t',
      'recovers an atomic inbox outcome after the COMMIT acknowledgement is lost',
    ],
    expectedFailure:
      /recovers an atomic inbox outcome after the COMMIT acknowledgement is lost/u,
    expectedFailureDetail:
      /duplicate key value violates unique constraint|acceptance_key/u,
  }),
  Object.freeze({
    id: 'accept-incompatible-benchmark-manifest',
    file: 'infrastructure/performance/compare-local-benchmark.mjs',
    search: '  if (baseline.manifestSha256 !== candidate.manifestSha256)\n',
    replacement: '  if (false)\n',
    command: [
      process.execPath,
      '--test',
      'infrastructure/performance/compare-local-benchmark.test.mjs',
    ],
    expectedFailure:
      /rejects host, runtime, service and manifest mismatches but allows source changes/u,
    expectedFailureDetail: /Missing expected exception/u,
  }),
]);

async function sourceFiles(sourceRoot = root, environment = process.env) {
  const result = await runMutationCommand(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    sourceRoot,
    180_000,
    environment,
  );
  if (!result.ok) throw new Error('Could not enumerate the candidate source');
  return result.stdout.split('\0').filter(Boolean).sort();
}

export async function copyMutationCandidate(
  destination,
  sourceRoot = root,
  environment = process.env,
) {
  for (const relative of await sourceFiles(sourceRoot, environment)) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(destination, relative);
    let metadata;
    try {
      metadata = await stat(source);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!metadata.isFile()) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, metadata.mode);
  }
}

export async function runMutationCommand(
  command,
  args,
  cwd,
  timeoutMillis = 180_000,
  environment = process.env,
  dependencies = {},
) {
  const supervisor = dependencies.supervisor ?? new OwnedProcessSupervisor();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let timeoutTermination;
  const append = (current, chunk, streamName) => {
    const next = current + String(chunk);
    if (Buffer.byteLength(next) > 16 * 1024 * 1024)
      throw new Error(
        `${command} ${streamName} exceeded the 16 MiB capture limit`,
      );
    return next;
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutTermination = supervisor.terminateAll('SIGTERM').then(
      () => ({ failed: false, error: undefined }),
      (error) => ({ failed: true, error }),
    );
  }, timeoutMillis);
  const startedAt = performance.now();
  let commandError;
  let commandFailed = false;
  try {
    await runManagedCommand({
      args,
      command,
      failure: (code, signal) =>
        new Error(`${command} failed (${String(code ?? signal)})`),
      onStdout: (chunk) => (stdout = append(stdout, chunk, 'stdout')),
      onStderr: (chunk) => (stderr = append(stderr, chunk, 'stderr')),
      releaseOwned: supervisor.release.bind(supervisor),
      spawnOwned: (file, arguments_, options) =>
        supervisor.spawn(file, arguments_, options),
      spawnOptions: {
        cwd,
        env: { ...isolatedGitEnvironment(environment), CI: '1' },
      },
    });
  } catch (error) {
    commandFailed = true;
    commandError = error;
  }
  clearTimeout(timeout);
  const cleanupFailures = [];
  const timedTermination = await timeoutTermination;
  if (timedTermination?.failed) cleanupFailures.push(timedTermination.error);
  try {
    await supervisor.terminateAll('SIGKILL');
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (timedOut) {
    const timeoutError = new Error(
      `${command} timed out after ${String(timeoutMillis)} ms`,
      commandFailed ? { cause: commandError } : undefined,
    );
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [timeoutError, ...cleanupFailures],
        `${command} timed out and cleanup failed`,
      );
    throw timeoutError;
  }
  if (cleanupFailures.length > 0) {
    const errors = commandFailed
      ? [commandError, ...cleanupFailures]
      : cleanupFailures;
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `${command} cleanup failed`);
  }
  const durationMs = performance.now() - startedAt;
  return commandFailed
    ? {
        ok: false,
        stdout,
        stderr,
        error:
          commandError instanceof Error
            ? commandError.message
            : String(commandError),
        durationMs,
      }
    : { ok: true, stdout, stderr, durationMs };
}

export async function initializeSnapshotRepository(
  snapshot,
  environment = process.env,
) {
  for (const [command, label] of [
    [['git', 'init'], 'Snapshot Git initialization'],
    [
      ['git', 'config', 'user.name', 'Pertexo mutation verifier'],
      'Snapshot Git user',
    ],
    [
      ['git', 'config', 'user.email', 'mutation-verifier@invalid.test'],
      'Snapshot Git email',
    ],
    [['git', 'add', '-A'], 'Snapshot Git staging'],
    [
      ['git', 'commit', '-m', 'test: snapshot mutation candidate'],
      'Snapshot Git commit',
    ],
  ])
    await requireGreen(command, snapshot, label, environment);
}

async function requireGreen(command, cwd, label, environment = process.env) {
  const [file, ...args] = command;
  const result = await runMutationCommand(
    file,
    args,
    cwd,
    180_000,
    environment,
  );
  if (!result.ok)
    throw new Error(
      `${label} did not pass:\n${`${result.stdout}\n${result.stderr}`.slice(-4_000)}`,
    );
  return result;
}

async function applyMutation(snapshot, mutation, replacement) {
  const file = path.join(snapshot, mutation.file);
  const source = await readFile(file, 'utf8');
  const occurrences = source.split(mutation.search).length - 1;
  if (occurrences !== 1)
    throw new Error(
      `${mutation.id}: expected one mutation site, found ${String(occurrences)}`,
    );
  await writeFile(file, source.replace(mutation.search, replacement));
  return source;
}

export function validateMutationDefinitions(mutations = MUTATIONS) {
  if (new Set(mutations.map(({ id }) => id)).size !== mutations.length)
    throw new Error('Mutation identifiers must be unique');
  for (const mutation of mutations)
    if (
      !mutation.id ||
      !mutation.file ||
      !mutation.search ||
      mutation.search === mutation.replacement ||
      !Array.isArray(mutation.command) ||
      mutation.command.length < 2 ||
      !(mutation.expectedFailure instanceof RegExp) ||
      !(mutation.expectedFailureDetail instanceof RegExp)
    )
      throw new Error('Mutation definition is incomplete');
  return mutations;
}

export async function verifyMutationSensitivity(environment = process.env) {
  validateMutationDefinitions();
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'pertexo-mutation-sensitivity-'),
  );
  const snapshot = path.join(directory, 'source');
  const evidence = [];
  let primary = { error: undefined, failed: false };
  try {
    await mkdir(snapshot);
    await copyMutationCandidate(snapshot, root, environment);
    await requireGreen(
      ['pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'],
      snapshot,
      'Snapshot dependency installation',
      environment,
    );
    await requireGreen(
      ['pnpm', 'build'],
      snapshot,
      'Snapshot build',
      environment,
    );
    await initializeSnapshotRepository(snapshot, environment);
    for (const mutation of MUTATIONS) {
      process.stderr.write(`Mutation red/green: ${mutation.id}\n`);
      const original = await applyMutation(
        snapshot,
        mutation,
        mutation.replacement,
      );
      if (mutation.prepare)
        await requireGreen(
          mutation.prepare,
          snapshot,
          `${mutation.id} red build`,
          environment,
        );
      const [file, ...args] = mutation.command;
      const red = await runMutationCommand(
        file,
        args,
        snapshot,
        180_000,
        environment,
      );
      const redOutput = `${red.stdout}\n${red.stderr}`;
      if (
        red.ok ||
        !mutation.expectedFailure.test(redOutput) ||
        !mutation.expectedFailureDetail.test(redOutput)
      )
        throw new Error(
          `${mutation.id}: mutation did not fail in its owning test for the expected reason:\n${redOutput.slice(-4_000)}`,
        );
      await writeFile(path.join(snapshot, mutation.file), original);
      if (mutation.prepare)
        await requireGreen(
          mutation.prepare,
          snapshot,
          `${mutation.id} restored build`,
          environment,
        );
      const green = await requireGreen(
        mutation.command,
        snapshot,
        `${mutation.id} restored test`,
        environment,
      );
      evidence.push({
        id: mutation.id,
        file: mutation.file,
        sourceSha256: createHash('sha256').update(original).digest('hex'),
        red: {
          expectedFailure: mutation.expectedFailure.source,
          expectedFailureDetail: mutation.expectedFailureDetail.source,
          durationMs: red.durationMs,
        },
        green: { durationMs: green.durationMs },
      });
    }
    return {
      schemaVersion: 1,
      status: 'complete',
      recordedAt: new Date().toISOString(),
      snapshot:
        'owned disposable copy of tracked and untracked candidate source',
      retryPolicy: 'disabled',
      mutations: evidence,
    };
  } catch (error) {
    primary = { error, failed: true };
    throw error;
  } finally {
    await preserveTemporaryDirectoryFailure(primary, () =>
      rm(directory, { recursive: true, force: true }),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  verifyMutationSensitivity()
    .then((evidence) =>
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`),
    )
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
