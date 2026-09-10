import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

import { capturePostgresEvidence } from './postgres-evidence.mjs';
import {
  OwnedProcessSupervisor,
  runManagedCommand,
} from '../owned-process-tree.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const requireDatabaseDependency = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
);
const processSupervisor = new OwnedProcessSupervisor();
let receivedSignal;
let activeTermination;
const databaseScopes = new Set([
  'configured-base',
  'runner-owned-fixture',
  'runner-owned-shared',
]);

function runnerOwnsScenarioDatabase(scenario) {
  return (
    scenario.databaseScope === 'runner-owned-fixture' ||
    scenario.databaseScope === 'runner-owned-shared'
  );
}

function requestOwnedProcessTermination(signal = 'SIGTERM') {
  const next = processSupervisor.terminateAll(signal);
  const previous = activeTermination;
  activeTermination =
    previous === undefined
      ? next
      : Promise.allSettled([previous, next]).then((results) => {
          const failures = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (failures.length > 0)
            throw new AggregateError(failures, 'Owned process cleanup failed');
        });
  void activeTermination.catch(() => undefined);
  return activeTermination;
}

function assertNotInterrupted() {
  if (receivedSignal) throw new Error(`Interrupted by ${receivedSignal}`);
}

export async function run(command, args, options = {}) {
  assertNotInterrupted();
  let stdout = '';
  let stderr = '';
  const result = await runManagedCommand({
    args,
    command,
    failure: (code, signal) =>
      new Error(
        `${command} failed (${String(code ?? signal)})${stderr || stdout ? `: ${stderr || stdout}` : ''}`,
      ),
    onStarted: options.started,
    onStdout: (chunk) => (stdout += String(chunk)),
    onStderr: (chunk) => (stderr += String(chunk)),
    releaseOwned:
      options.releaseOwned ?? processSupervisor.release.bind(processSupervisor),
    spawnOwned:
      options.spawnOwned ?? processSupervisor.spawn.bind(processSupervisor),
    spawnOptions: {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    },
  });
  return { ...result, stdout, stderr };
}

export function percentile(values, proportion) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(proportion * sorted.length) - 1] ?? sorted[0];
}

export function summarize(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    minimum: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    maximum: Math.max(...values),
    mean,
    standardDeviation: Math.sqrt(variance),
    coefficientOfVariation:
      mean === 0 ? 0 : Math.sqrt(variance) / Math.abs(mean),
  };
}

const operationTimingMarker = 'PERTEXO_Q11_OPERATION_V2=';

export function parseOperationSamples(output) {
  const samples = [];
  for (const line of output.split(/\r?\n/u)) {
    const markerIndex = line.indexOf(operationTimingMarker);
    if (markerIndex === -1) continue;
    const remainder = line.slice(markerIndex + operationTimingMarker.length);
    const closingBrace = remainder.lastIndexOf('}');
    let parsed;
    try {
      parsed = JSON.parse(remainder.slice(0, closingBrace + 1));
    } catch {
      throw new Error(`Malformed Q11 operation timing marker: ${line}`);
    }
    if (
      closingBrace < 1 ||
      parsed?.schemaVersion !== 2 ||
      typeof parsed.name !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{0,79}$/u.test(parsed.name) ||
      !Number.isFinite(parsed.startedAtUnixMs) ||
      !Number.isFinite(parsed.endedAtUnixMs) ||
      parsed.endedAtUnixMs <= parsed.startedAtUnixMs ||
      !Number.isSafeInteger(parsed.population) ||
      parsed.population < 1 ||
      typeof parsed.boundary !== 'string' ||
      parsed.boundary.trim().length === 0 ||
      (parsed.databaseIdentity !== undefined &&
        (typeof parsed.databaseIdentity.database !== 'string' ||
          typeof parsed.databaseIdentity.role !== 'string' ||
          typeof parsed.databaseIdentity.applicationName !== 'string'))
    )
      throw new Error(`Malformed Q11 operation timing marker: ${line}`);
    samples.push(
      Object.freeze({
        name: parsed.name,
        startedAtUnixMs: parsed.startedAtUnixMs,
        endedAtUnixMs: parsed.endedAtUnixMs,
        durationMs: parsed.endedAtUnixMs - parsed.startedAtUnixMs,
        population: parsed.population,
        boundary: parsed.boundary,
        databaseIdentity: parsed.databaseIdentity,
      }),
    );
  }
  return samples;
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 4)
    throw new Error('Unsupported benchmark manifest');
  if (!Number.isInteger(manifest.rounds) || manifest.rounds < 3)
    throw new Error('Benchmark requires at least three measured rounds');
  if (!Number.isInteger(manifest.warmupRounds) || manifest.warmupRounds < 1)
    throw new Error('Benchmark requires at least one warmup round');
  if (!Number.isInteger(manifest.seed))
    throw new Error('Benchmark seed must be an integer');
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0)
    throw new Error('Benchmark scenarios are required');
  const names = new Set();
  for (const scenario of manifest.scenarios) {
    if (
      typeof scenario.name !== 'string' ||
      scenario.name.trim().length === 0 ||
      names.has(scenario.name)
    )
      throw new Error(
        'Benchmark scenario names must be unique non-empty strings',
      );
    names.add(scenario.name);
    if (!Number.isInteger(scenario.concurrency) || scenario.concurrency < 1)
      throw new Error(
        `${scenario.name}: concurrency must be a positive integer`,
      );
    if (
      scenario.fixturePopulation === null ||
      typeof scenario.fixturePopulation !== 'object' ||
      Array.isArray(scenario.fixturePopulation) ||
      Object.keys(scenario.fixturePopulation).length === 0
    )
      throw new Error(`${scenario.name}: fixturePopulation is required`);
    if (!Array.isArray(scenario.commands) || scenario.commands.length === 0)
      throw new Error(`${scenario.name}: commands are required`);
    const participants = new Set();
    const operationNames = new Set();
    for (const command of scenario.commands) {
      if (
        typeof command.file !== 'string' ||
        !Array.isArray(command.args) ||
        !Array.isArray(command.expectedOperations) ||
        command.expectedOperations.length === 0
      )
        throw new Error(`${scenario.name}: command must use an argv array`);
      for (const operation of command.expectedOperations) {
        if (
          typeof operation.name !== 'string' ||
          !/^[a-z0-9][a-z0-9.-]{0,79}$/u.test(operation.name) ||
          !Number.isSafeInteger(operation.count) ||
          operation.count < 1 ||
          !Number.isSafeInteger(operation.population) ||
          operation.population < 1 ||
          typeof operation.boundary !== 'string' ||
          operation.boundary.trim().length === 0 ||
          (operation.databaseScope !== undefined &&
            operation.databaseScope !== 'runner-owned-shared')
        )
          throw new Error(
            `${scenario.name}: expected operation contracts are invalid`,
          );
        if (operationNames.has(operation.name))
          throw new Error(
            `${scenario.name}: expected operation names must be unique`,
          );
        operationNames.add(operation.name);
      }
      if (scenario.requireOverlap === true) {
        if (
          typeof command.participant !== 'string' ||
          !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(command.participant) ||
          participants.has(command.participant)
        )
          throw new Error(
            `${scenario.name}: overlap participants must be unique`,
          );
        participants.add(command.participant);
      }
    }
    if (scenario.requireOverlap === true && scenario.commands.length < 2)
      throw new Error(`${scenario.name}: overlap requires multiple commands`);
    if (
      scenario.databaseScope !== undefined &&
      !databaseScopes.has(scenario.databaseScope)
    )
      throw new Error(`${scenario.name}: database scope is invalid`);
    if (
      scenario.requireOverlap === true &&
      scenario.databaseScope !== 'runner-owned-shared'
    )
      throw new Error(`${scenario.name}: overlap requires a shared database`);
  }
  return manifest;
}

async function sourceIdentity() {
  const head = await run('git', ['rev-parse', 'HEAD']);
  const files = await run('git', [
    'ls-files',
    '-co',
    '--exclude-standard',
    '-z',
  ]);
  if (head.code !== 0 || files.code !== 0)
    throw new Error('Cannot identify source tree');
  const hash = createHash('sha256');
  const paths = files.stdout.split('\0').filter(Boolean).sort();
  let dirtyFiles = 0;
  const status = await run('git', ['status', '--porcelain=v1', '-z']);
  for (const relative of paths) {
    hash.update(relative).update('\0');
    try {
      hash.update(await readFile(path.join(root, relative)));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hash.update('<deleted>');
    }
    hash.update('\0');
  }
  dirtyFiles = status.stdout.split('\0').filter(Boolean).length;
  return {
    head: head.stdout.trim(),
    workingTreeSha256: hash.digest('hex'),
    trackedAndUntrackedFileCount: paths.length,
    dirty: dirtyFiles > 0,
    dirtyEntryCount: dirtyFiles,
  };
}

function serviceConfigurationSha256(environment) {
  const keys = Object.keys(environment)
    .filter((key) =>
      /^(?:DATABASE_[A-Z_]+_URL|REDIS_URL|S3_[A-Z_]+|OBJECT_STORE_[A-Z_]+)$/u.test(
        key,
      ),
    )
    .filter(
      (key) => !/(?:SECRET|PASSWORD|TOKEN|CREDENTIAL|ACCESS_KEY)/u.test(key),
    )
    .sort();
  const normalized = keys.map((key) => {
    const value = environment[key];
    if (typeof value !== 'string') return [key, value];
    if (value.length === 0) return [key, 'unconfigured'];
    if (/_URL$|_ENDPOINT$/u.test(key)) {
      const url = new URL(value);
      return [
        key,
        {
          protocol: url.protocol,
          role: url.username,
          hostScope:
            url.hostname === '127.0.0.1' || url.hostname === 'localhost'
              ? 'loopback'
              : url.hostname,
          pathname: url.pathname,
        },
      ];
    }
    return [key, value];
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function processGroupMetrics(rootPid) {
  const result = await run('ps', ['-axo', 'pid=,pgid=,rss=,%cpu=']);
  if (result.code !== 0) return null;
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter(
      ([pid, processGroupId, rss, cpuPercent]) =>
        pid && processGroupId >= 0 && rss >= 0 && cpuPercent >= 0,
    )
    .filter(([, processGroupId]) => processGroupId === rootPid);
  return {
    processCount: rows.length,
    rssBytes: rows.reduce((sum, row) => sum + row[2] * 1024, 0),
    cpuPercent: rows.reduce((sum, row) => sum + row[3], 0),
  };
}

function expectedOperationCount(command) {
  return command.expectedOperations.reduce(
    (sum, operation) => sum + operation.count,
    0,
  );
}

function validateOperationContract(
  scenario,
  command,
  samples,
  sharedDatabaseName,
) {
  const expectedCount = expectedOperationCount(command);
  if (samples.length !== expectedCount)
    throw new Error(
      `${scenario.name} emitted ${String(samples.length)} Q11 operation timings; expected ${String(expectedCount)}`,
    );
  for (const expected of command.expectedOperations) {
    const matching = samples.filter(({ name }) => name === expected.name);
    if (
      matching.length !== expected.count ||
      matching.some(
        ({ population, boundary, databaseIdentity }) =>
          population !== expected.population ||
          boundary !== expected.boundary ||
          (expected.databaseScope === 'runner-owned-shared' &&
            (databaseIdentity === undefined ||
              databaseIdentity.database !== sharedDatabaseName ||
              databaseIdentity.role.length === 0 ||
              databaseIdentity.applicationName !==
                `q11-${scenario.name}-${command.participant ?? 'foreground'}`.slice(
                  0,
                  63,
                ))),
      )
    )
      throw new Error(
        `${scenario.name} violated the ${expected.name} operation count or population contract`,
      );
  }
  const expectedNames = new Set(
    command.expectedOperations.map(({ name }) => name),
  );
  if (samples.some(({ name }) => !expectedNames.has(name)))
    throw new Error(`${scenario.name} emitted an undeclared Q11 operation`);
}

function withDatabaseAndApplicationName(
  baseUrl,
  databaseName,
  applicationName,
) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

function scenarioCommandEnvironment(environment, scenario, command) {
  if (!runnerOwnsScenarioDatabase(scenario)) return environment;
  const databaseName = environment.PERTEXO_Q11_DATABASE_NAME;
  const participant = command.participant ?? 'foreground';
  const applicationName = `q11-${scenario.name}-${participant}`.slice(0, 63);
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key,
      /^DATABASE_(?:ADMIN|MIGRATION|API|WORKER|DISPATCHER|MAINTENANCE|OPERATOR|LIFECYCLE_COMMAND)_URL$/u.test(
        key,
      ) &&
      key !== 'DATABASE_ADMIN_URL' &&
      typeof value === 'string' &&
      value.length > 0
        ? withDatabaseAndApplicationName(value, databaseName, applicationName)
        : value,
    ]),
  );
}

async function prepareScenarioDatabase(scenario, environment) {
  if (!runnerOwnsScenarioDatabase(scenario))
    return { environment, close: async () => undefined };
  if (!environment.DATABASE_ADMIN_URL || !environment.DATABASE_MIGRATION_URL)
    throw new Error(`${scenario.name}: shared database URLs are required`);
  const databaseName = `pertexo_q11_${randomUUID().replaceAll('-', '')}`;
  const { Client } = requireDatabaseDependency('pg');
  const admin = new Client({
    connectionString: environment.DATABASE_ADMIN_URL,
  });
  let created = false;
  try {
    await admin.connect();
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    created = true;
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_maintenance,pertexo_api,pertexo_worker,pertexo_dispatcher,
       pertexo_lifecycle_command,pertexo_operator`,
    );
    const ownedEnvironment = {
      ...environment,
      PERTEXO_Q11_RUNNER_OWNS_DATABASE: '1',
      PERTEXO_Q11_DATABASE_NAME: databaseName,
      ...(scenario.databaseScope === 'runner-owned-shared'
        ? {
            PERTEXO_Q11_SHARED_DATABASE: '1',
            PERTEXO_Q11_SHARED_DATABASE_NAME: databaseName,
          }
        : {}),
    };
    const commandEnvironment = scenarioCommandEnvironment(
      ownedEnvironment,
      scenario,
      { participant: 'setup' },
    );
    const reset =
      scenario.databaseScope === 'runner-owned-fixture'
        ? async () => {
            const resetUrl = new URL(environment.DATABASE_ADMIN_URL);
            resetUrl.pathname = `/${databaseName}`;
            const resetClient = new Client({
              connectionString: resetUrl.toString(),
            });
            await runWithOwnedDatabaseClient(
              resetClient,
              async () => {
                await resetClient.connect();
                await resetClient.query(
                  'drop schema if exists app cascade; drop schema if exists pertexo_internal cascade',
                );
              },
              `${scenario.name}: fixture database reset`,
            );
          }
        : undefined;
    if (scenario.databaseScope === 'runner-owned-shared') {
      const migration = await run(
        'pnpm',
        ['--filter', '@pertexo/database', 'db:migrate'],
        { env: commandEnvironment },
      );
      if (migration.code !== 0)
        throw new Error(
          `${scenario.name}: shared database migration failed: ${migration.stderr.slice(-2_000)}`,
        );
    }
    return {
      environment: commandEnvironment,
      databaseName,
      reset,
      close: () => closeRunnerOwnedScenarioDatabase(admin, databaseName),
    };
  } catch (error) {
    try {
      await closeRunnerOwnedScenarioDatabase(
        admin,
        created ? databaseName : undefined,
        { force: true },
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${scenario.name}: database setup failed and cleanup was incomplete`,
      );
    }
    throw error;
  }
}

export async function runWithOwnedDatabaseClient(client, operation, label) {
  let operationError;
  try {
    await operation();
  } catch (error) {
    operationError = error;
  }
  let closeError;
  try {
    await client.end();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined)
    throw new AggregateError(
      [operationError, closeError],
      `${label} failed and its client could not close`,
    );
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
}

export async function closeRunnerOwnedScenarioDatabase(
  admin,
  databaseName,
  options = {},
) {
  let databaseError;
  try {
    if (databaseName !== undefined) {
      if (options.force === true)
        await admin.query(
          `drop database if exists "${databaseName}" with (force)`,
        );
      else {
        await admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity
            where datname=$1 and pid<>pg_backend_pid()`,
          [databaseName],
        );
        await admin.query(`drop database "${databaseName}"`);
      }
    }
  } catch (error) {
    databaseError = error;
  }
  let clientError;
  try {
    await admin.end();
  } catch (error) {
    clientError = error;
  }
  if (databaseError !== undefined && clientError !== undefined)
    throw new AggregateError(
      [databaseError, clientError],
      'Runner-owned scenario database and admin client cleanup failed',
    );
  if (databaseError !== undefined) throw databaseError;
  if (clientError !== undefined) throw clientError;
}

async function waitForOverlapBarrier(directory, executions) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ready = await Promise.all(
      executions.map(async ({ command }) => {
        try {
          await access(path.join(directory, `${command.participant}.ready`));
          return true;
        } catch (error) {
          if (error?.code === 'ENOENT') return false;
          throw error;
        }
      }),
    );
    if (ready.every(Boolean)) {
      await writeFile(path.join(directory, 'release'), '', { flag: 'wx' });
      return;
    }
    const earlyExit = executions.find(
      ({ settled }, index) => settled && ready[index] !== true,
    );
    if (earlyExit !== undefined)
      throw new Error(
        `${earlyExit.command.participant} exited before reaching the Q11 overlap barrier`,
      );
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for the Q11 overlap barrier');
    await delay(25);
  }
}

function overlapEvidence(workloads, scenario) {
  const intervals = workloads.map(({ command, samples }) => ({
    participant: command.participant,
    startedAtUnixMs: Math.min(
      ...samples.map(({ startedAtUnixMs }) => startedAtUnixMs),
    ),
    endedAtUnixMs: Math.max(
      ...samples.map(({ endedAtUnixMs }) => endedAtUnixMs),
    ),
  }));
  const overlapStartedAtUnixMs = Math.max(
    ...intervals.map(({ startedAtUnixMs }) => startedAtUnixMs),
  );
  const overlapEndedAtUnixMs = Math.min(
    ...intervals.map(({ endedAtUnixMs }) => endedAtUnixMs),
  );
  if (overlapEndedAtUnixMs <= overlapStartedAtUnixMs)
    throw new Error('Q11 contention workloads did not overlap');
  const databaseIdentities = workloads.flatMap(({ samples }) =>
    samples.map(({ databaseIdentity }) => databaseIdentity).filter(Boolean),
  );
  if (scenario.databaseScope === 'runner-owned-shared') {
    const databases = new Set(
      databaseIdentities.map(({ database }) => database),
    );
    if (databaseIdentities.length !== workloads.length || databases.size !== 1)
      throw new Error(
        'Q11 contention workloads did not use one shared database',
      );
  }
  return {
    verified: true,
    overlapStartedAtUnixMs,
    overlapEndedAtUnixMs,
    overlapDurationMs: overlapEndedAtUnixMs - overlapStartedAtUnixMs,
    intervals,
    databaseIdentities,
  };
}

async function executeRound(scenario, inheritedEnvironment, roundIndex) {
  const startedAt = process.hrtime.bigint();
  const processSamples = [];
  const children = [];
  const overlapDirectory =
    scenario.requireOverlap === true
      ? await mkdtemp(path.join(os.tmpdir(), 'pertexo-q11-overlap-'))
      : undefined;
  const executions = scenario.commands.flatMap((command) =>
    Array.from({ length: scenario.concurrency }, (_, concurrencyIndex) => {
      const execution = {
        command,
        concurrencyIndex,
        settled: false,
        promise: undefined,
      };
      const commandEnvironment = scenarioCommandEnvironment(
        inheritedEnvironment,
        scenario,
        command,
      );
      execution.promise = run(command.file, command.args, {
        env: {
          ...commandEnvironment,
          ...command.environment,
          PERTEXO_Q11_OPERATION_TIMING: '1',
          PERTEXO_Q11_ROUND_INDEX: String(roundIndex),
          ...(overlapDirectory === undefined
            ? {}
            : {
                PERTEXO_Q11_OVERLAP_DIRECTORY: overlapDirectory,
                PERTEXO_Q11_OVERLAP_PARTICIPANT: command.participant,
              }),
        },
        started: (child) => children.push(child),
      }).finally(() => {
        execution.settled = true;
      });
      return execution;
    }),
  );
  let sampling = true;
  const sampleStartedAt = performance.now();
  let samplingError;
  const sampler = (async () => {
    try {
      while (sampling) {
        const values = await Promise.all(
          children
            .filter(({ pid }) => pid !== undefined)
            .map(({ pid }) => processGroupMetrics(pid)),
        );
        const available = values.filter((value) => value !== null);
        if (available.length > 0)
          processSamples.push({
            elapsedMs: performance.now() - sampleStartedAt,
            processCount: available.reduce(
              (sum, value) => sum + value.processCount,
              0,
            ),
            rssBytes: available.reduce((sum, value) => sum + value.rssBytes, 0),
            cpuPercent: available.reduce(
              (sum, value) => sum + value.cpuPercent,
              0,
            ),
          });
        await delay(100);
      }
    } catch (error) {
      samplingError = error;
    }
  })();
  let results;
  let roundError;
  try {
    if (overlapDirectory !== undefined)
      await waitForOverlapBarrier(overlapDirectory, executions);
    results = await Promise.all(executions.map(({ promise }) => promise));
  } catch (error) {
    roundError = error;
    const cleanup = await Promise.allSettled([
      processSupervisor.terminateAll(),
      ...executions.map(({ promise }) => promise),
    ]);
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (cleanupFailures.length > 0)
      roundError = new AggregateError(
        [error, ...cleanupFailures],
        `${scenario.name} failed and cleanup was incomplete`,
      );
  }
  sampling = false;
  await sampler;
  let overlapCleanupError;
  if (overlapDirectory !== undefined)
    try {
      await rm(overlapDirectory, { recursive: true, force: true });
    } catch (error) {
      overlapCleanupError = error;
    }
  const trailingErrors = [samplingError, overlapCleanupError].filter(
    (error) => error !== undefined,
  );
  if (roundError !== undefined && trailingErrors.length > 0)
    throw new AggregateError(
      [roundError, ...trailingErrors],
      `${scenario.name} failed and diagnostics cleanup was incomplete`,
    );
  if (roundError !== undefined) throw roundError;
  if (trailingErrors.length > 0)
    throw new AggregateError(
      trailingErrors,
      `${scenario.name} diagnostics cleanup failed`,
    );
  const launcherElapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const failure = results.find((result) => result.code !== 0);
  if (failure)
    throw new Error(
      `${scenario.name} failed (${String(failure.code ?? failure.signal)}): ${failure.stderr.slice(-2_000)}`,
    );
  const workloads = executions.map((execution, index) => {
    const result = results[index];
    const samples = parseOperationSamples(`${result.stdout}\n${result.stderr}`);
    validateOperationContract(
      scenario,
      execution.command,
      samples,
      inheritedEnvironment.PERTEXO_Q11_SHARED_DATABASE_NAME,
    );
    return { ...execution, samples };
  });
  const operationSamples = workloads.flatMap(({ samples }) => samples);
  const workloadStartedAtUnixMs = Math.min(
    ...operationSamples.map(({ startedAtUnixMs }) => startedAtUnixMs),
  );
  const workloadEndedAtUnixMs = Math.max(
    ...operationSamples.map(({ endedAtUnixMs }) => endedAtUnixMs),
  );
  const workloadIntervalMs = workloadEndedAtUnixMs - workloadStartedAtUnixMs;
  return {
    operationSamples,
    operationLatencyMs: operationSamples.map(({ durationMs }) => durationMs),
    workloadInterval: {
      startedAtUnixMs: workloadStartedAtUnixMs,
      endedAtUnixMs: workloadEndedAtUnixMs,
      durationMs: workloadIntervalMs,
    },
    operationThroughputPerSecond:
      operationSamples.length / (workloadIntervalMs / 1_000),
    overlap:
      scenario.requireOverlap === true
        ? overlapEvidence(workloads, scenario)
        : null,
    launcherElapsedMs,
    workloadProcessMetrics: {
      sampleIntervalMs: 100,
      samples: processSamples,
      peakRssBytes:
        processSamples.length === 0
          ? null
          : Math.max(...processSamples.map(({ rssBytes }) => rssBytes)),
      peakCpuPercent:
        processSamples.length === 0
          ? null
          : Math.max(...processSamples.map(({ cpuPercent }) => cpuPercent)),
      peakProcessCount:
        processSamples.length === 0
          ? null
          : Math.max(...processSamples.map(({ processCount }) => processCount)),
      rssTrendBytes:
        processSamples.length === 0
          ? null
          : {
              first: processSamples[0].rssBytes,
              last: processSamples.at(-1).rssBytes,
              delta:
                processSamples.at(-1).rssBytes - processSamples[0].rssBytes,
            },
    },
  };
}

export async function startDatabaseSampler(environment, options = {}) {
  if (!environment.DATABASE_ADMIN_URL || !environment.DATABASE_MIGRATION_URL)
    return {
      stop: async () => ({
        available: false,
        reason: 'isolated database connection details were not provided',
      }),
    };
  const databaseName = new URL(environment.DATABASE_MIGRATION_URL).pathname
    .slice(1)
    .split('/')[0];
  const { Client } = options.Client ? options : requireDatabaseDependency('pg');
  const client = new Client({
    connectionString: environment.DATABASE_ADMIN_URL,
    connectionTimeoutMillis: 2_000,
  });
  const statisticsUrl = new URL(environment.DATABASE_ADMIN_URL);
  statisticsUrl.pathname = new URL(environment.DATABASE_MIGRATION_URL).pathname;
  const statistics = new Client({
    connectionString: statisticsUrl.toString(),
    connectionTimeoutMillis: 2_000,
  });
  let clientConnected = false;
  let statisticsConnected = false;
  let workloadTracker;
  try {
    await client.connect();
    clientConnected = true;
    await statistics.connect();
    statisticsConnected = true;
    await statistics.query('create extension if not exists pg_stat_statements');
    workloadTracker = await createDatabaseWorkloadTracker(
      statistics,
      databaseName,
    );
  } catch (error) {
    const closing = await Promise.allSettled([
      clientConnected ? client.end() : Promise.resolve(),
      statisticsConnected ? statistics.end() : Promise.resolve(),
    ]);
    const closeFailures = closing.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (closeFailures.length > 0)
      throw new AggregateError(
        [error, ...closeFailures],
        'PostgreSQL benchmark sampler startup and cleanup failed',
      );
    throw error;
  }
  const samples = [];
  let stopped = false;
  let samplingError;
  const sampling = (async () => {
    while (!stopped) {
      try {
        const result = await client.query(
          `/* pertexo-q11-sampler */
           select pg_database_size($1)::float8 database_size_bytes,
                  count(*)::int connection_count,
                  count(*) filter (where state='active')::int active_task_count,
                  count(*) filter (where wait_event_type='Lock')::int lock_wait_count
             from pg_stat_activity where datname=$1`,
          [databaseName],
        );
        const row = result.rows[0];
        samples.push({
          recordedAt: new Date().toISOString(),
          databaseSizeBytes: Number(row.database_size_bytes),
          connectionCount: Number(row.connection_count),
          activeTaskCount: Number(row.active_task_count),
          lockWaitCount: Number(row.lock_wait_count),
        });
      } catch (error) {
        samplingError = error instanceof Error ? error.message : String(error);
        stopped = true;
        break;
      }
      await delay(250);
    }
  })();
  return {
    ...workloadTracker,
    stop: async () => {
      stopped = true;
      await sampling;
      const closing = await Promise.allSettled([
        client.end(),
        statistics.end(),
      ]);
      const closeFailures = closing.filter(
        (result) => result.status === 'rejected',
      );
      if (closeFailures.length > 0)
        throw new AggregateError(
          closeFailures.map((result) => result.reason),
          'PostgreSQL benchmark samplers did not close cleanly',
        );
      return samplingError === undefined
        ? {
            available: true,
            sampleIntervalMs: 250,
            samples,
            databaseSizeBytes: summarize(
              samples.map(({ databaseSizeBytes }) => databaseSizeBytes),
            ),
            connectionCount: summarize(
              samples.map(({ connectionCount }) => connectionCount),
            ),
            activeTaskCount: summarize(
              samples.map(({ activeTaskCount }) => activeTaskCount),
            ),
            lockWaitCount: summarize(
              samples.map(({ lockWaitCount }) => lockWaitCount),
            ),
          }
        : { available: false, reason: samplingError, samples };
    },
  };
}

export async function createDatabaseWorkloadTracker(statistics, databaseName) {
  const database = await statistics.query(
    `select oid::int8 database_oid
       from pg_database
      where datname=$1`,
    [databaseName],
  );
  const databaseOid = Number(database.rows[0]?.database_oid);
  if (!Number.isSafeInteger(databaseOid) || databaseOid < 1)
    throw new Error(
      `Cannot resolve PostgreSQL database OID for ${databaseName}`,
    );
  return {
    beginScenario: async () => {
      await statistics.query(
        'select pg_stat_statements_reset(0::oid,$1::oid,0::bigint)',
        [databaseOid],
      );
    },
    endScenario: async () => {
      const result = await statistics.query(
        `select coalesce(sum(calls),0)::float8 sql_round_trips,
                coalesce(sum(total_exec_time),0)::float8 server_execution_ms
           from pg_stat_statements
          where dbid=$1::oid
            and query not like '/* pertexo-q11-sampler */%'
            and query not like '%pg_stat_statements%'`,
        [databaseOid],
      );
      return {
        sqlRoundTrips: Number(result.rows[0]?.sql_round_trips ?? 0),
        serverExecutionMs: Number(result.rows[0]?.server_execution_ms ?? 0),
      };
    },
  };
}

export async function benchmark(
  manifest,
  environment = process.env,
  options = {},
) {
  validateManifest(manifest);
  if (environment.PERTEXO_Q11_ISOLATED !== '1')
    throw new Error(
      'Refusing benchmark outside the Q02-owned isolated services',
    );
  assertNotInterrupted();
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const benchmarkEnvironment = {
    ...environment,
    PERTEXO_BENCHMARK_SEED: String(manifest.seed),
  };
  const createDatabaseSampler =
    options.startDatabaseSampler ?? startDatabaseSampler;
  const createScenarioDatabase =
    options.prepareScenarioDatabase ?? prepareScenarioDatabase;
  const databaseSampler = await createDatabaseSampler(benchmarkEnvironment);
  const scenarios = [];
  let databaseObservations;
  let benchmarkError;
  try {
    for (const scenario of manifest.scenarios) {
      assertNotInterrupted();
      const scenarioDatabase = await createScenarioDatabase(
        scenario,
        benchmarkEnvironment,
      );
      let targetDatabaseSampler;
      let targetDatabaseObservations;
      let targetDatabaseWorkload;
      let scenarioError;
      const rounds = [];
      try {
        await databaseSampler.beginScenario?.();
        if (scenarioDatabase.databaseName !== undefined) {
          targetDatabaseSampler = await createDatabaseSampler(
            scenarioDatabase.environment,
          );
          await targetDatabaseSampler.beginScenario?.();
        }
        for (let index = 0; index < manifest.warmupRounds; index += 1) {
          assertNotInterrupted();
          await scenarioDatabase.reset?.();
          await executeRound(
            scenario,
            scenarioDatabase.environment,
            -index - 1,
          );
        }
        for (let index = 0; index < manifest.rounds; index += 1) {
          assertNotInterrupted();
          await scenarioDatabase.reset?.();
          rounds.push(
            await executeRound(scenario, scenarioDatabase.environment, index),
          );
        }
        targetDatabaseWorkload = await targetDatabaseSampler?.endScenario?.();
      } catch (error) {
        scenarioError = error;
      }
      const cleanupErrors = [];
      try {
        targetDatabaseObservations = await targetDatabaseSampler?.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await scenarioDatabase.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (scenarioError !== undefined && cleanupErrors.length === 0)
        throw scenarioError;
      if (scenarioError !== undefined || cleanupErrors.length > 0)
        throw new AggregateError(
          [scenarioError, ...cleanupErrors].filter(Boolean),
          `${scenario.name} failed or its shared database did not close cleanly`,
        );
      const databaseWorkload = await databaseSampler.endScenario?.();
      const expectedOperationsPerRound =
        scenario.concurrency *
        scenario.commands.reduce(
          (sum, command) => sum + expectedOperationCount(command),
          0,
        );
      scenarios.push({
        name: scenario.name,
        description: scenario.description,
        configuration: {
          concurrency: scenario.concurrency,
          expectedOperationsPerRound,
          fixturePopulation: scenario.fixturePopulation,
          workloadProcessCount: scenario.commands.length * scenario.concurrency,
          requireOverlap: scenario.requireOverlap === true,
          databaseScope: scenario.databaseScope ?? 'configured-base',
          operationContracts: scenario.commands.flatMap((command) =>
            command.expectedOperations.map((operation) => ({
              ...operation,
              participant: command.participant ?? null,
            })),
          ),
        },
        rounds,
        operationLatencyMs: summarize(
          rounds.flatMap((round) => round.operationLatencyMs),
        ),
        operationThroughputPerSecond: summarize(
          rounds.map((round) => round.operationThroughputPerSecond),
        ),
        launcherElapsedMs: summarize(
          rounds.map((round) => round.launcherElapsedMs),
        ),
        workloadProcessPeakRssBytes: summarize(
          rounds.flatMap((round) =>
            round.workloadProcessMetrics.peakRssBytes === null
              ? []
              : [round.workloadProcessMetrics.peakRssBytes],
          ),
        ),
        workloadProcessPeakCpuPercent: summarize(
          rounds.flatMap((round) =>
            round.workloadProcessMetrics.peakCpuPercent === null
              ? []
              : [round.workloadProcessMetrics.peakCpuPercent],
          ),
        ),
        workloadProcessPeakCount: summarize(
          rounds.flatMap((round) =>
            round.workloadProcessMetrics.peakProcessCount === null
              ? []
              : [round.workloadProcessMetrics.peakProcessCount],
          ),
        ),
        workloadProcessRssDeltaBytes: summarize(
          rounds.flatMap((round) =>
            round.workloadProcessMetrics.rssTrendBytes === null
              ? []
              : [round.workloadProcessMetrics.rssTrendBytes.delta],
          ),
        ),
        operationBreakdown: Object.fromEntries(
          [
            ...new Set(
              rounds.flatMap((round) =>
                round.operationSamples.map(({ name }) => name),
              ),
            ),
          ].map((name) => [
            name,
            {
              latencyMs: summarize(
                rounds.flatMap((round) =>
                  round.operationSamples
                    .filter((sample) => sample.name === name)
                    .map(({ durationMs }) => durationMs),
                ),
              ),
              throughputPerSecond: summarize(
                rounds.flatMap((round) => {
                  const samples = round.operationSamples.filter(
                    (sample) => sample.name === name,
                  );
                  if (samples.length === 0) return [];
                  const interval =
                    Math.max(
                      ...samples.map(({ endedAtUnixMs }) => endedAtUnixMs),
                    ) -
                    Math.min(
                      ...samples.map(({ startedAtUnixMs }) => startedAtUnixMs),
                    );
                  return [samples.length / (interval / 1_000)];
                }),
              ),
              populations: [
                ...new Set(
                  rounds.flatMap((round) =>
                    round.operationSamples
                      .filter((sample) => sample.name === name)
                      .map(({ population }) => population),
                  ),
                ),
              ],
            },
          ]),
        ),
        databaseWorkload,
        targetDatabase: scenarioDatabase.databaseName
          ? {
              scope:
                scenario.databaseScope === 'runner-owned-shared'
                  ? 'runner-owned shared disposable database'
                  : 'runner-owned fixture database',
              databaseName: scenarioDatabase.databaseName,
              workload: targetDatabaseWorkload,
              observations: targetDatabaseObservations,
            }
          : null,
      });
    }
  } catch (error) {
    benchmarkError = error;
  }
  let samplerStopError;
  try {
    databaseObservations = await databaseSampler.stop();
  } catch (error) {
    samplerStopError = error;
  }
  lag.disable();
  if (benchmarkError !== undefined && samplerStopError !== undefined)
    throw new AggregateError(
      [benchmarkError, samplerStopError],
      'Benchmark failed and database sampler cleanup was incomplete',
    );
  if (benchmarkError !== undefined) throw benchmarkError;
  if (samplerStopError !== undefined) throw samplerStopError;
  const postgresEvidence = await capturePostgresEvidence(benchmarkEnvironment);
  const pnpm = await run('pnpm', ['--version']);
  const foregroundAlone = scenarios.find(
    ({ name }) => name === 'foreground-alone',
  );
  const foregroundContended = scenarios.find(
    ({ name }) => name === 'retention-versus-foreground',
  );
  const aloneLatency =
    foregroundAlone?.operationBreakdown?.['foreground-acceptance']?.latencyMs;
  const contendedLatency =
    foregroundContended?.operationBreakdown?.['foreground-acceptance']
      ?.latencyMs;
  const interferenceComparison =
    aloneLatency && contendedLatency
      ? {
          operation: 'foreground-acceptance',
          population: 32,
          databaseSetup: 'runner-owned shared disposable database per scenario',
          alone: {
            latencyMs: aloneLatency,
            throughputPerSecond:
              foregroundAlone.operationBreakdown['foreground-acceptance']
                .throughputPerSecond,
          },
          withRetention: {
            latencyMs: contendedLatency,
            throughputPerSecond:
              foregroundContended.operationBreakdown['foreground-acceptance']
                .throughputPerSecond,
          },
          ratios: {
            meanLatency: contendedLatency.mean / aloneLatency.mean,
            p95Latency: contendedLatency.p95 / aloneLatency.p95,
          },
          interpretation:
            'Temporal overlap demonstrates concurrent work on one database; it does not by itself establish a row-lock conflict.',
        }
      : null;
  return {
    schemaVersion: 4,
    status: 'complete',
    recordedAt: new Date().toISOString(),
    source: await sourceIdentity(),
    manifestSha256: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
    environment: {
      node: process.version,
      pnpm: pnpm.stdout.trim(),
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      seed: manifest.seed,
      warmupRounds: manifest.warmupRounds,
      measuredRounds: manifest.rounds,
      serviceConfigurationSha256:
        serviceConfigurationSha256(benchmarkEnvironment),
    },
    orchestratorDiagnostics: {
      heapUsedBytesAtEnd: process.memoryUsage().heapUsed,
      eventLoopDelayNanoseconds: {
        p50: lag.percentile(50),
        p95: lag.percentile(95),
        p99: lag.percentile(99),
        maximum: lag.max,
      },
      scope:
        'benchmark orchestrator only; never substituted for workload-process metrics',
    },
    workloadMetricLimitations: {
      heap: 'per-process Node heap is unavailable across pnpm and Vitest descendants without intrusive runtime instrumentation; process-group RSS samples are retained instead',
      eventLoop:
        'per-process event-loop lag is unavailable across heterogeneous child process trees; only explicitly labeled orchestrator diagnostics are retained',
    },
    databaseObservations: {
      ...databaseObservations,
      scope:
        'disposable PostgreSQL size, connection, active-task and lock-wait samples',
    },
    postgresEvidence,
    interferenceComparison,
    scenarios,
  };
}

async function main() {
  const [manifestFile, outputFile, option] = process.argv.slice(2);
  if (!manifestFile)
    throw new Error(
      'Usage: run-local-benchmark.mjs <manifest> <output> [--validate]',
    );
  const manifest = validateManifest(
    JSON.parse(await readFile(path.resolve(manifestFile), 'utf8')),
  );
  if (option === '--validate') return;
  if (!outputFile) throw new Error('Output path is required');
  let primaryError;
  try {
    const evidence = await benchmark(manifest);
    if (receivedSignal) throw new Error(`Interrupted by ${receivedSignal}`);
    const handle = await open(path.resolve(outputFile), 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  try {
    await requestOwnedProcessTermination();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== undefined && cleanupError !== undefined)
    throw new AggregateError(
      [primaryError, cleanupError],
      'Benchmark failed and owned process cleanup was incomplete',
    );
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      receivedSignal = signal;
      requestOwnedProcessTermination(signal);
    });
  main().catch((error) => {
    const describeError = (candidate, indentation = '') => {
      const message =
        candidate instanceof Error ? candidate.message : String(candidate);
      if (!(candidate instanceof AggregateError))
        return `${indentation}${message}`;
      return [
        `${indentation}${message}`,
        ...candidate.errors.map((cause) =>
          describeError(cause, `${indentation}- `),
        ),
      ].join('\n');
    };
    const details = describeError(error);
    process.stderr.write(`${details}\n`);
    process.exitCode = receivedSignal ? 130 : 1;
  });
}
