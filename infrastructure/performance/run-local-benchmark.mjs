import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  access,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

import { capturePostgresEvidence } from './postgres-evidence.mjs';
import { validateBenchmarkEvidence } from './compare-local-benchmark.mjs';
import {
  OwnedProcessSupervisor,
  runManagedCommand,
} from '../owned-process-tree.mjs';
import { isolatedGitEnvironment } from '../git-environment.mjs';

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
const COMMAND_TIMEOUT_MILLIS = 600_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DATABASE_CONNECTION_TIMEOUT_MILLIS = 2_000;
const DATABASE_QUERY_TIMEOUT_MILLIS = 30_000;
const SAMPLER_STOP_GRACE_MILLIS = 1_000;
const EVIDENCE_SCHEMA_VERSION = 5;
const BENCHMARK_TIMEOUT_MILLIS = 600_000;

function settled(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}

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
  const append = (current, chunk, stream) => {
    const next = current + String(chunk);
    if (Buffer.byteLength(next) > COMMAND_OUTPUT_LIMIT_BYTES)
      throw new Error(
        `${command} ${stream} exceeded the ${String(COMMAND_OUTPUT_LIMIT_BYTES)} byte capture limit`,
      );
    return next;
  };
  const result = await runManagedCommand({
    args,
    command,
    failure: (code, signal) =>
      new Error(
        `${command} failed (${String(code ?? signal)})${stderr || stdout ? `: ${stderr || stdout}` : ''}`,
      ),
    onStarted: options.started,
    onStdout: (chunk) => (stdout = append(stdout, chunk, 'stdout')),
    onStderr: (chunk) => (stderr = append(stderr, chunk, 'stderr')),
    releaseOwned:
      options.releaseOwned ?? processSupervisor.release.bind(processSupervisor),
    spawnOwned:
      options.spawnOwned ?? processSupervisor.spawn.bind(processSupervisor),
    spawnOptions: {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    },
    timeoutFailure: () =>
      new Error(
        `${command} timed out after ${String(options.timeoutMillis ?? COMMAND_TIMEOUT_MILLIS)} ms`,
      ),
    timeoutMillis: options.timeoutMillis ?? COMMAND_TIMEOUT_MILLIS,
  });
  return { ...result, stdout, stderr };
}

export function percentile(values, proportion) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(proportion * sorted.length) - 1] ?? sorted[0];
}

function sameFileIdentity(left, right) {
  return (
    left === undefined ||
    right === undefined ||
    (left.dev === right.dev && left.ino === right.ino)
  );
}

export async function reserveBenchmarkEvidence(outputFile, operations = {}) {
  const openOutput = operations.open ?? open;
  const removeOutput = operations.rm ?? rm;
  const inspectOutput = operations.stat ?? stat;
  const resolvedOutput = path.resolve(outputFile);
  const handle = await openOutput(resolvedOutput, 'wx');
  const reservationIdentity =
    typeof handle.stat === 'function' ? await handle.stat() : undefined;
  let closed = false;
  let closeAttempted = false;
  let finalized = false;

  const close = async () => {
    if (closed || closeAttempted) return;
    closeAttempted = true;
    await handle.close();
    closed = true;
  };
  const removeReservation = async () => {
    if (reservationIdentity === undefined) {
      await removeOutput(resolvedOutput, { force: true });
      return;
    }
    let currentIdentity;
    try {
      currentIdentity = await inspectOutput(resolvedOutput);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!sameFileIdentity(reservationIdentity, currentIdentity))
      throw new Error(
        'Benchmark output ownership changed before incomplete artifact cleanup',
      );
    await removeOutput(resolvedOutput, { force: true });
  };
  const abandon = async (primaryError) => {
    if (finalized) return;
    const failures = primaryError === undefined ? [] : [primaryError];
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await removeReservation();
    } catch (error) {
      failures.push(error);
    }
    finalized = true;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        'Benchmark failed and its incomplete output reservation could not be cleaned up safely',
      );
  };

  return Object.freeze({
    path: resolvedOutput,
    abandon,
    complete: async (evidence) => {
      if (finalized)
        throw new Error('Benchmark output reservation is already finalized');
      try {
        validateBenchmarkEvidence(evidence, 'Generated benchmark');
        await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
        await close();
        finalized = true;
      } catch (error) {
        await abandon(error);
      }
    },
  });
}

export async function writeBenchmarkEvidence(
  outputFile,
  evidence,
  operations = {},
) {
  validateBenchmarkEvidence(evidence, 'Generated benchmark');
  const reservation = await reserveBenchmarkEvidence(outputFile, operations);
  await reservation.complete(evidence);
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

const OPERATION_TIMING_MARKER = 'PERTEXO_Q11_OPERATION_V2=';
const OPERATION_TIMING_SCHEMA_VERSION = 2;

function operationTimingMarkerError(line) {
  return new Error(`Malformed Q11 operation timing marker: ${line}`);
}

function assertOperationTimingIdentity(parsed, line) {
  if (
    parsed?.schemaVersion !== OPERATION_TIMING_SCHEMA_VERSION ||
    typeof parsed.name !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{0,79}$/u.test(parsed.name)
  )
    throw operationTimingMarkerError(line);
}

function assertOperationTimingInterval(parsed, line) {
  if (
    !Number.isFinite(parsed.startedAtUnixMs) ||
    !Number.isFinite(parsed.endedAtUnixMs) ||
    parsed.endedAtUnixMs <= parsed.startedAtUnixMs
  )
    throw operationTimingMarkerError(line);
}

function assertOperationTimingWorkload(parsed, line) {
  if (
    !Number.isSafeInteger(parsed.population) ||
    parsed.population < 1 ||
    typeof parsed.boundary !== 'string' ||
    parsed.boundary.trim().length === 0
  )
    throw operationTimingMarkerError(line);
}

function assertOperationDatabaseIdentity(parsed, line) {
  if (parsed.databaseIdentity === undefined) return;
  const identity = parsed.databaseIdentity;
  if (
    typeof identity?.database !== 'string' ||
    typeof identity.role !== 'string' ||
    typeof identity.applicationName !== 'string'
  )
    throw operationTimingMarkerError(line);
}

export function parseOperationSamples(output) {
  const samples = [];
  for (const line of output.split(/\r?\n/u)) {
    const markerIndex = line.indexOf(OPERATION_TIMING_MARKER);
    if (markerIndex === -1) continue;
    const remainder = line.slice(markerIndex + OPERATION_TIMING_MARKER.length);
    const closingBrace = remainder.lastIndexOf('}');
    let parsed;
    try {
      parsed = JSON.parse(remainder.slice(0, closingBrace + 1));
    } catch {
      throw operationTimingMarkerError(line);
    }
    if (closingBrace < 1) throw operationTimingMarkerError(line);
    assertOperationTimingIdentity(parsed, line);
    assertOperationTimingInterval(parsed, line);
    assertOperationTimingWorkload(parsed, line);
    assertOperationDatabaseIdentity(parsed, line);
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

function assertManifestHeader(manifest) {
  if (manifest?.schemaVersion !== EVIDENCE_SCHEMA_VERSION)
    throw new Error('Unsupported benchmark manifest');
  if (
    !Number.isSafeInteger(manifest.rounds) ||
    manifest.rounds < 3 ||
    manifest.rounds > 100
  )
    throw new Error('Benchmark requires at least three measured rounds');
  if (
    !Number.isSafeInteger(manifest.warmupRounds) ||
    manifest.warmupRounds < 1 ||
    manifest.warmupRounds > 100
  )
    throw new Error('Benchmark requires at least one warmup round');
  if (!Number.isSafeInteger(manifest.seed))
    throw new Error('Benchmark seed must be a safe integer');
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0)
    throw new Error('Benchmark scenarios are required');
}

function assertScenarioShape(scenario, names) {
  if (
    typeof scenario.name !== 'string' ||
    scenario.name.trim().length === 0 ||
    names.has(scenario.name)
  )
    throw new Error(
      'Benchmark scenario names must be unique non-empty strings',
    );
  names.add(scenario.name);
  if (
    !Number.isSafeInteger(scenario.concurrency) ||
    scenario.concurrency < 1 ||
    scenario.concurrency > 64
  )
    throw new Error(
      `${scenario.name}: concurrency must be a bounded positive safe integer`,
    );
  const hasFixturePopulation =
    scenario.fixturePopulation !== null &&
    typeof scenario.fixturePopulation === 'object' &&
    !Array.isArray(scenario.fixturePopulation) &&
    Object.keys(scenario.fixturePopulation).length > 0;
  if (!hasFixturePopulation)
    throw new Error(`${scenario.name}: fixturePopulation is required`);
  if (
    Object.values(scenario.fixturePopulation).some(
      (population) => !Number.isSafeInteger(population) || population < 1,
    )
  )
    throw new Error(
      `${scenario.name}: fixture populations must be positive safe integers`,
    );
  if (!Array.isArray(scenario.commands) || scenario.commands.length === 0)
    throw new Error(`${scenario.name}: commands are required`);
}

function assertExpectedOperation(operation, operationNames, scenario) {
  const scenarioName = scenario.name;
  if (
    typeof operation.name !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{0,79}$/u.test(operation.name)
  )
    throw new Error(
      `${scenarioName}: expected operation contracts are invalid`,
    );
  if (
    !Number.isSafeInteger(operation.count) ||
    operation.count < 1 ||
    !Number.isSafeInteger(operation.population) ||
    operation.population < 1
  )
    throw new Error(
      `${scenarioName}: expected operation contracts are invalid`,
    );
  if (
    typeof operation.boundary !== 'string' ||
    operation.boundary.trim().length === 0
  )
    throw new Error(
      `${scenarioName}: expected operation contracts are invalid`,
    );
  const expectedDatabaseScope =
    scenario.databaseScope === 'runner-owned-shared'
      ? 'runner-owned-shared'
      : undefined;
  if (operation.databaseScope !== expectedDatabaseScope)
    throw new Error(
      `${scenarioName}: expected operation contracts are invalid`,
    );
  if (operationNames.has(operation.name))
    throw new Error(`${scenarioName}: expected operation names must be unique`);
  operationNames.add(operation.name);
}

function assertScenarioCommands(scenario) {
  const participants = new Set();
  const operationNames = new Set();
  for (const command of scenario.commands) {
    const hasArgvContract =
      typeof command.file === 'string' &&
      command.file.trim().length > 0 &&
      Array.isArray(command.args) &&
      command.args.every((argument) => typeof argument === 'string') &&
      Array.isArray(command.expectedOperations) &&
      command.expectedOperations.length > 0;
    if (!hasArgvContract)
      throw new Error(`${scenario.name}: command must use an argv array`);
    for (const operation of command.expectedOperations)
      assertExpectedOperation(operation, operationNames, scenario);
    if (scenario.databaseScope === 'runner-owned-shared') {
      const hasUniqueParticipant =
        typeof command.participant === 'string' &&
        /^[a-z0-9][a-z0-9-]{0,39}$/u.test(command.participant) &&
        !participants.has(command.participant);
      if (!hasUniqueParticipant)
        throw new Error(
          `${scenario.name}: shared-database participants must be unique`,
        );
      participants.add(command.participant);
    }
  }
}

function assertScenarioDatabasePolicy(scenario) {
  if (scenario.requireOverlap === true && scenario.commands.length < 2)
    throw new Error(`${scenario.name}: overlap requires multiple commands`);
  if (!databaseScopes.has(scenario.databaseScope))
    throw new Error(`${scenario.name}: database scope is invalid`);
  if (
    scenario.requireOverlap === true &&
    scenario.databaseScope !== 'runner-owned-shared'
  )
    throw new Error(`${scenario.name}: overlap requires a shared database`);
  if (scenario.requireOverlap === true && scenario.concurrency !== 1)
    throw new Error(
      `${scenario.name}: overlap barrier supports exactly one execution per participant`,
    );
}

export function validateManifest(manifest) {
  assertManifestHeader(manifest);
  const names = new Set();
  for (const scenario of manifest.scenarios) {
    assertScenarioShape(scenario, names);
    assertScenarioCommands(scenario);
    assertScenarioDatabasePolicy(scenario);
  }
  return {
    ...manifest,
    scenarios: manifest.scenarios.map((scenario) => ({
      ...scenario,
      requireOverlap: scenario.requireOverlap === true,
      commands: scenario.commands.map((command) => ({
        ...command,
        args: [...command.args],
        expectedOperations: command.expectedOperations.map((operation) => ({
          ...operation,
        })),
      })),
      fixturePopulation: { ...scenario.fixturePopulation },
    })),
  };
}

async function sourceIdentity(options = {}) {
  const gitEnvironment = isolatedGitEnvironment(process.env);
  const excluded = new Set(
    (options.excludedPaths ?? []).map((file) =>
      path.relative(root, path.resolve(file)),
    ),
  );
  const commandOptions = { cwd: root, env: gitEnvironment };
  const head = await run('git', ['rev-parse', 'HEAD'], commandOptions);
  const files = await run(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    commandOptions,
  );
  if (head.code !== 0 || files.code !== 0)
    throw new Error('Cannot identify source tree');
  const hash = createHash('sha256');
  const paths = files.stdout
    .split('\0')
    .filter((file) => file.length > 0 && !excluded.has(file))
    .sort();
  let dirtyFiles = 0;
  const status = await run(
    'git',
    ['status', '--porcelain=v1', '-z'],
    commandOptions,
  );
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
  dirtyFiles = status.stdout.split('\0').filter((entry) => {
    if (entry.length === 0) return false;
    const relative = entry.slice(3);
    return !excluded.has(relative);
  }).length;
  return {
    head: head.stdout.trim(),
    workingTreeSha256: hash.digest('hex'),
    trackedAndUntrackedFileCount: paths.length,
    dirty: dirtyFiles > 0,
    dirtyEntryCount: dirtyFiles,
  };
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    },
  );
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory()) return filesBelow(item);
        return entry.isFile() ? [item] : [];
      }),
    )
  ).flat();
}

async function buildOutputIdentity() {
  const owners = await Promise.all(
    ['apps', 'packages'].map(async (collection) => {
      const directory = path.join(root, collection);
      const entries = await readdir(directory, { withFileTypes: true });
      return (
        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map((entry) =>
              filesBelow(path.join(directory, entry.name, 'dist')),
            ),
        )
      ).flat();
    }),
  );
  const files = owners.flat().sort();
  if (files.length === 0)
    throw new Error('Benchmark build produced no compiled package output');
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file)).update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return {
    outputSha256: hash.digest('hex'),
    fileCount: files.length,
  };
}

async function qualifyBuild() {
  await run('pnpm', ['build'], { timeoutMillis: 1_200_000 });
  return buildOutputIdentity();
}

const retainedConnectionParameters = new Set([
  'application_name',
  'connect_timeout',
  'sslmode',
  'target_session_attrs',
]);

function normalizedServiceUrl(value) {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  return {
    protocol: url.protocol,
    role: url.username,
    hostScope: loopback ? 'loopback' : url.hostname,
    portScope: loopback ? 'ephemeral-loopback' : url.port || 'default',
    pathname: url.pathname,
    parameters: [...url.searchParams]
      .filter(([name]) => retainedConnectionParameters.has(name))
      .sort(([left], [right]) => left.localeCompare(right)),
  };
}

function serviceConfigurationSha256(environment) {
  const keys = Object.keys(environment)
    .filter((key) =>
      /^(?:DATABASE_[A-Z_]+_URL|REDIS_URL|S3_[A-Z_]+|OBJECT_STORE_[A-Z_]+|POSTGRES_IMAGE|REDIS_IMAGE|MINIO_IMAGE)$/u.test(
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
      return [key, normalizedServiceUrl(value)];
    }
    return [key, value];
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function processGroupMetrics(rootPid) {
  const result = await run('ps', ['-axo', 'pid=,pgid=,rss=,%cpu='], {
    timeoutMillis: 10_000,
  });
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
    if (matching.length !== expected.count)
      throw new Error(
        `${scenario.name} violated the ${expected.name} operation count or population contract`,
      );
    const expectedApplicationName =
      `q11-${scenario.name}-${command.participant ?? 'foreground'}`.slice(
        0,
        63,
      );
    const sampleViolatesContract = matching.some(
      ({ population, boundary, databaseIdentity }) => {
        if (
          population !== expected.population ||
          boundary !== expected.boundary
        )
          return true;
        if (expected.databaseScope !== 'runner-owned-shared') return false;
        return (
          databaseIdentity === undefined ||
          databaseIdentity.database !== sharedDatabaseName ||
          databaseIdentity.role.length === 0 ||
          databaseIdentity.applicationName !== expectedApplicationName
        );
      },
    );
    if (sampleViolatesContract)
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
  const databaseName = `pertexo_test_q11_${randomUUID().replaceAll('-', '')}`;
  const { Client } = requireDatabaseDependency('pg');
  const admin = new Client({
    connectionString: environment.DATABASE_ADMIN_URL,
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
    query_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
    statement_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
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
              connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
              query_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
              statement_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
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
  let operationFailed = false;
  let operationError;
  try {
    await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let closeFailed = false;
  let closeError;
  try {
    await client.end();
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }
  if (operationFailed && closeFailed)
    throw new AggregateError(
      [operationError, closeError],
      `${label} failed and its client could not close`,
    );
  if (operationFailed) throw operationError;
  if (closeFailed) throw closeError;
}

export async function closeRunnerOwnedScenarioDatabase(
  admin,
  databaseName,
  options = {},
) {
  let databaseFailed = false;
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
    databaseFailed = true;
    databaseError = error;
  }
  let clientFailed = false;
  let clientError;
  try {
    await admin.end();
  } catch (error) {
    clientFailed = true;
    clientError = error;
  }
  if (databaseFailed && clientFailed)
    throw new AggregateError(
      [databaseError, clientError],
      'Runner-owned scenario database and admin client cleanup failed',
    );
  if (databaseFailed) throw databaseError;
  if (clientFailed) throw clientError;
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
  const executions = [];
  let overlapDirectory;
  let sampling = false;
  let samplerOutcome = Promise.resolve({ status: 'fulfilled' });
  let roundEvidence;
  let primaryFailed = false;
  let primaryError;
  const cleanupErrors = [];
  try {
    overlapDirectory =
      scenario.requireOverlap === true
        ? await mkdtemp(path.join(os.tmpdir(), 'pertexo-q11-overlap-'))
        : undefined;
    for (const command of scenario.commands)
      for (
        let concurrencyIndex = 0;
        concurrencyIndex < scenario.concurrency;
        concurrencyIndex += 1
      ) {
        const execution = {
          command,
          concurrencyIndex,
          settled: false,
          outcome: undefined,
        };
        executions.push(execution);
        const commandEnvironment = scenarioCommandEnvironment(
          inheritedEnvironment,
          scenario,
          command,
        );
        execution.outcome = run(command.file, command.args, {
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
        }).then(
          (value) => {
            execution.settled = true;
            return { status: 'fulfilled', value };
          },
          (reason) => {
            execution.settled = true;
            return { status: 'rejected', reason };
          },
        );
      }
    sampling = true;
    const sampleStartedAt = performance.now();
    samplerOutcome = settled(
      (async () => {
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
              rssBytes: available.reduce(
                (sum, value) => sum + value.rssBytes,
                0,
              ),
              cpuPercent: available.reduce(
                (sum, value) => sum + value.cpuPercent,
                0,
              ),
            });
          await delay(100);
        }
      })(),
    );
    if (overlapDirectory !== undefined)
      await waitForOverlapBarrier(overlapDirectory, executions);
    const outcomes = await Promise.all(
      executions.map(({ outcome }) => outcome),
    );
    const executionFailures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (executionFailures.length === 1) throw executionFailures[0];
    if (executionFailures.length > 1)
      throw new AggregateError(
        executionFailures,
        `${scenario.name} workload commands failed`,
      );
    const results = outcomes.map(({ value }) => value);
    const launcherElapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const workloads = executions.map((execution, index) => {
      const result = results[index];
      const samples = parseOperationSamples(
        `${result.stdout}\n${result.stderr}`,
      );
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
    // The sampler may finish one in-flight `ps` observation after the workload
    // commands settle. Retain one immutable snapshot so the raw samples and
    // their derived summary cannot describe different observation sets.
    const completedProcessSamples = processSamples.slice();
    roundEvidence = {
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
        samples: completedProcessSamples,
        peakRssBytes:
          completedProcessSamples.length === 0
            ? null
            : Math.max(
                ...completedProcessSamples.map(({ rssBytes }) => rssBytes),
              ),
        peakCpuPercent:
          completedProcessSamples.length === 0
            ? null
            : Math.max(
                ...completedProcessSamples.map(({ cpuPercent }) => cpuPercent),
              ),
        peakProcessCount:
          completedProcessSamples.length === 0
            ? null
            : Math.max(
                ...completedProcessSamples.map(
                  ({ processCount }) => processCount,
                ),
              ),
        rssTrendBytes:
          completedProcessSamples.length === 0
            ? null
            : {
                first: completedProcessSamples[0].rssBytes,
                last: completedProcessSamples.at(-1).rssBytes,
                delta:
                  completedProcessSamples.at(-1).rssBytes -
                  completedProcessSamples[0].rssBytes,
              },
      },
    };
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
    const cleanup = await Promise.allSettled([
      processSupervisor.terminateAll(),
      ...executions
        .map(({ outcome }) => outcome)
        .filter((outcome) => outcome !== undefined),
    ]);
    cleanupErrors.push(
      ...cleanup.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      ),
    );
    for (const outcome of cleanup.slice(1))
      if (
        outcome.status === 'fulfilled' &&
        outcome.value?.status === 'rejected' &&
        outcome.value.reason !== primaryError
      )
        cleanupErrors.push(outcome.value.reason);
  }
  sampling = false;
  const sampler = await samplerOutcome;
  if (sampler.status === 'rejected') cleanupErrors.push(sampler.reason);
  if (overlapDirectory !== undefined)
    try {
      await rm(overlapDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  if (primaryFailed && cleanupErrors.length > 0)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `${scenario.name} failed and diagnostics cleanup was incomplete`,
    );
  if (primaryFailed) throw primaryError;
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      cleanupErrors,
      `${scenario.name} diagnostics cleanup failed`,
    );
  return roundEvidence;
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
  const samplerStopGraceMillis =
    options.samplerStopGraceMillis ?? SAMPLER_STOP_GRACE_MILLIS;
  if (
    !Number.isSafeInteger(samplerStopGraceMillis) ||
    samplerStopGraceMillis < 1
  )
    throw new Error('Sampler stop grace must be a positive safe integer');
  const client = new Client({
    connectionString: environment.DATABASE_ADMIN_URL,
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
    query_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
    statement_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
  });
  const statisticsUrl = new URL(environment.DATABASE_ADMIN_URL);
  statisticsUrl.pathname = new URL(environment.DATABASE_MIGRATION_URL).pathname;
  const statistics = new Client({
    connectionString: statisticsUrl.toString(),
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
    query_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
    statement_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
  });
  let workloadTracker;
  try {
    await client.connect();
    await statistics.connect();
    await statistics.query('create extension if not exists pg_stat_statements');
    workloadTracker = await createDatabaseWorkloadTracker(
      statistics,
      databaseName,
    );
  } catch (error) {
    const closing = await Promise.allSettled([client.end(), statistics.end()]);
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
      const completedBeforeCancellation = await Promise.race([
        sampling.then(() => true),
        delay(samplerStopGraceMillis, false, { ref: false }),
      ]);
      let clientClose;
      if (!completedBeforeCancellation)
        clientClose = Promise.resolve().then(() => client.end());
      await sampling;
      const closing = await Promise.allSettled([
        clientClose ?? Promise.resolve().then(() => client.end()),
        Promise.resolve().then(() => statistics.end()),
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
  const captureScenario = async () => {
    const result = await statistics.query(
      `select coalesce(sum(calls),0)::float8 statement_executions,
              coalesce(sum(total_exec_time),0)::float8 server_execution_ms
         from pg_stat_statements
        where dbid=$1::oid
          and query not like '/* pertexo-q11-sampler */%'
          and query not like '/* pertexo-q11-statistics */%'
          and query not like '%pg_stat_statements%'`,
      [databaseOid],
    );
    const statementExecutions = Number(
      result.rows[0]?.statement_executions ?? 0,
    );
    const serverExecutionMs = Number(result.rows[0]?.server_execution_ms ?? 0);
    if (
      !Number.isSafeInteger(statementExecutions) ||
      statementExecutions < 0 ||
      !Number.isFinite(serverExecutionMs) ||
      serverExecutionMs < 0
    )
      throw new Error('PostgreSQL returned invalid statement statistics');
    return { statementExecutions, serverExecutionMs };
  };
  return {
    beginScenario: async () => {
      await statistics.query(
        'select pg_stat_statements_reset(0::oid,$1::oid,0::bigint)',
        [databaseOid],
      );
    },
    captureScenario,
  };
}

function subtractSqlSnapshot(after, before) {
  const statementExecutions =
    after.statementExecutions - before.statementExecutions;
  const serverExecutionMs = after.serverExecutionMs - before.serverExecutionMs;
  if (
    !Number.isSafeInteger(statementExecutions) ||
    statementExecutions < 0 ||
    !Number.isFinite(serverExecutionMs) ||
    serverExecutionMs < -1e-9
  )
    throw new Error('PostgreSQL statement statistics moved backwards');
  return {
    statementExecutions,
    serverExecutionMs: Math.max(0, serverExecutionMs),
  };
}

function sumSqlMeasurements(measurements) {
  return measurements.reduce(
    (total, measurement) => ({
      statementExecutions:
        total.statementExecutions + measurement.statementExecutions,
      serverExecutionMs:
        total.serverExecutionMs + measurement.serverExecutionMs,
    }),
    { statementExecutions: 0, serverExecutionMs: 0 },
  );
}

function createScenarioSqlRecorder(sampler, warmupRounds, measuredRounds) {
  if (
    typeof sampler?.beginScenario !== 'function' ||
    typeof sampler?.captureScenario !== 'function'
  )
    return null;
  const phaseMeasurements = {
    fixtureReset: [],
    warmupWorkload: [],
    measuredWorkload: [],
  };
  let origin;
  return {
    begin: async () => {
      await sampler.beginScenario();
      origin = await sampler.captureScenario();
    },
    before: () => sampler.captureScenario(),
    record: (phase, roundIndex, before, after) => {
      phaseMeasurements[phase].push({
        roundIndex,
        ...subtractSqlSnapshot(after, before),
      });
    },
    finish: async () => {
      const completed = await sampler.captureScenario();
      const total = subtractSqlSnapshot(completed, origin);
      const classified = sumSqlMeasurements(
        Object.values(phaseMeasurements).flat(),
      );
      const unclassified = subtractSqlSnapshot(total, classified);
      if (
        phaseMeasurements.fixtureReset.length !==
          warmupRounds + measuredRounds ||
        phaseMeasurements.warmupWorkload.length !== warmupRounds ||
        phaseMeasurements.measuredWorkload.length !== measuredRounds
      )
        throw new Error(
          'PostgreSQL scenario phase measurements are incomplete',
        );
      return {
        scope: 'scenarioIncludingWarmupAndFixtures',
        ...total,
        phaseMeasurements,
        unclassified,
      };
    },
  };
}

async function measureSqlPhase(recorders, phase, roundIndex, operation) {
  const active = recorders.filter(Boolean);
  const capture = async (label) => {
    const outcomes = await Promise.allSettled(
      active.map((recorder) => recorder.before()),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        `PostgreSQL ${label} snapshots failed`,
      );
    return outcomes.map(({ value }) => value);
  };
  const before = await capture('before-phase');
  const result = await operation();
  const after = await capture('after-phase');
  for (const [index, recorder] of active.entries())
    recorder.record(phase, roundIndex, before[index], after[index]);
  return result;
}

async function finishSqlRecorders(base, target) {
  const recorders = [base, target];
  const outcomes = await Promise.allSettled(
    recorders.map((recorder) =>
      recorder === null ? Promise.resolve(undefined) : recorder.finish(),
    ),
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      'PostgreSQL scenario measurements failed',
    );
  return outcomes.map(({ value }) => value);
}

function summarizeScenario({
  databaseWorkload,
  rounds,
  scenario,
  targetDatabaseObservations,
  targetDatabaseWorkload,
  targetDatabaseName,
}) {
  const expectedOperationsPerRound =
    scenario.concurrency *
    scenario.commands.reduce(
      (sum, command) => sum + expectedOperationCount(command),
      0,
    );
  const samplesByOperation = new Map();
  for (const round of rounds)
    for (const sample of round.operationSamples) {
      const samples = samplesByOperation.get(sample.name) ?? [];
      samples.push(sample);
      samplesByOperation.set(sample.name, samples);
    }
  const operationBreakdown = Object.fromEntries(
    [...samplesByOperation].map(([name, samples]) => {
      const roundThroughputs = rounds.flatMap((round) => {
        const roundSamples = round.operationSamples.filter(
          (sample) => sample.name === name,
        );
        if (roundSamples.length === 0) return [];
        const interval =
          Math.max(...roundSamples.map(({ endedAtUnixMs }) => endedAtUnixMs)) -
          Math.min(
            ...roundSamples.map(({ startedAtUnixMs }) => startedAtUnixMs),
          );
        return [roundSamples.length / (interval / 1_000)];
      });
      return [
        name,
        {
          latencyMs: summarize(samples.map(({ durationMs }) => durationMs)),
          throughputPerSecond: summarize(roundThroughputs),
          populations: [
            ...new Set(samples.map(({ population }) => population)),
          ],
        },
      ];
    }),
  );
  return {
    name: scenario.name,
    description: scenario.description,
    configuration: {
      concurrency: scenario.concurrency,
      expectedOperationsPerRound,
      fixturePopulation: scenario.fixturePopulation,
      workloadProcessCount: scenario.commands.length * scenario.concurrency,
      requireOverlap: scenario.requireOverlap,
      databaseScope: scenario.databaseScope,
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
    operationBreakdown,
    databaseWorkload,
    targetDatabase:
      targetDatabaseName === undefined
        ? null
        : {
            scope:
              scenario.databaseScope === 'runner-owned-shared'
                ? 'runner-owned shared disposable database'
                : 'runner-owned fixture database',
            databaseName: targetDatabaseName,
            workload: targetDatabaseWorkload,
            observations: targetDatabaseObservations,
          },
  };
}

export async function benchmark(
  inputManifest,
  environment = process.env,
  options = {},
) {
  const manifest = validateManifest(inputManifest);
  if (environment.PERTEXO_Q11_ISOLATED !== '1')
    throw new Error(
      'Refusing benchmark outside the Q02-owned isolated services',
    );
  assertNotInterrupted();
  const identifySource = options.sourceIdentity ?? sourceIdentity;
  const excludedPaths = options.excludedSourcePaths ?? [];
  const sourceStarted = await identifySource({ excludedPaths });
  const buildStarted = await (options.qualifyBuild ?? qualifyBuild)();
  const sourceAfterBuild = await identifySource({ excludedPaths });
  if (sourceStarted.workingTreeSha256 !== sourceAfterBuild.workingTreeSha256)
    throw new Error('Source changed while qualifying the benchmark build');
  const benchmarkEnvironment = {
    ...environment,
    PERTEXO_BENCHMARK_SEED: String(manifest.seed),
  };
  const createDatabaseSampler =
    options.startDatabaseSampler ?? startDatabaseSampler;
  const createScenarioDatabase =
    options.prepareScenarioDatabase ?? prepareScenarioDatabase;
  const createEventLoopMonitor =
    options.createEventLoopMonitor ?? monitorEventLoopDelay;
  const lag = createEventLoopMonitor({ resolution: 10 });
  const benchmarkTimeoutMillis =
    options.benchmarkTimeoutMillis ?? BENCHMARK_TIMEOUT_MILLIS;
  if (
    !Number.isSafeInteger(benchmarkTimeoutMillis) ||
    benchmarkTimeoutMillis < 1
  )
    throw new Error('Benchmark timeout must be a positive safe integer');
  let deadlineError;
  const deadline = setTimeout(() => {
    deadlineError = new Error(
      `Benchmark timed out after ${String(benchmarkTimeoutMillis)} ms`,
    );
    requestOwnedProcessTermination();
  }, benchmarkTimeoutMillis);
  deadline.unref();
  const assertWithinDeadline = () => {
    if (deadlineError !== undefined) throw deadlineError;
    assertNotInterrupted();
  };
  const scenarios = [];
  let databaseSampler;
  let databaseObservations;
  let benchmarkFailed = false;
  let benchmarkError;
  let monitorEnabled = false;
  try {
    lag.enable();
    monitorEnabled = true;
    databaseSampler = await createDatabaseSampler(benchmarkEnvironment);
    for (const scenario of manifest.scenarios) {
      assertWithinDeadline();
      const scenarioDatabase = await createScenarioDatabase(
        scenario,
        benchmarkEnvironment,
      );
      let targetDatabaseSampler;
      let targetDatabaseObservations;
      let targetDatabaseWorkload;
      let databaseWorkload;
      let scenarioFailed = false;
      let scenarioError;
      const rounds = [];
      try {
        if (scenarioDatabase.databaseName !== undefined) {
          targetDatabaseSampler = await createDatabaseSampler(
            scenarioDatabase.environment,
          );
        }
        const databaseRecorder = createScenarioSqlRecorder(
          databaseSampler,
          manifest.warmupRounds,
          manifest.rounds,
        );
        const targetDatabaseRecorder = createScenarioSqlRecorder(
          targetDatabaseSampler,
          manifest.warmupRounds,
          manifest.rounds,
        );
        const recorders = [databaseRecorder, targetDatabaseRecorder].filter(
          Boolean,
        );
        const started = await Promise.allSettled(
          recorders.map((recorder) => recorder.begin()),
        );
        const startFailures = started.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason] : [],
        );
        if (startFailures.length === 1) throw startFailures[0];
        if (startFailures.length > 1)
          throw new AggregateError(
            startFailures,
            'PostgreSQL scenario measurement startup failed',
          );
        for (let index = 0; index < manifest.warmupRounds; index += 1) {
          assertWithinDeadline();
          const roundIndex = -index - 1;
          await measureSqlPhase(recorders, 'fixtureReset', roundIndex, () =>
            scenarioDatabase.reset?.(),
          );
          await measureSqlPhase(recorders, 'warmupWorkload', roundIndex, () =>
            executeRound(scenario, scenarioDatabase.environment, roundIndex),
          );
        }
        for (let index = 0; index < manifest.rounds; index += 1) {
          assertWithinDeadline();
          await measureSqlPhase(recorders, 'fixtureReset', index, () =>
            scenarioDatabase.reset?.(),
          );
          rounds.push(
            await measureSqlPhase(recorders, 'measuredWorkload', index, () =>
              executeRound(scenario, scenarioDatabase.environment, index),
            ),
          );
        }
        [databaseWorkload, targetDatabaseWorkload] = await finishSqlRecorders(
          databaseRecorder,
          targetDatabaseRecorder,
        );
      } catch (error) {
        scenarioFailed = true;
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
      if (scenarioFailed && cleanupErrors.length === 0) throw scenarioError;
      if (scenarioFailed || cleanupErrors.length > 0)
        throw new AggregateError(
          [...(scenarioFailed ? [scenarioError] : []), ...cleanupErrors],
          `${scenario.name} failed or its shared database did not close cleanly`,
        );
      scenarios.push(
        summarizeScenario({
          databaseWorkload,
          rounds,
          scenario,
          targetDatabaseName: scenarioDatabase.databaseName,
          targetDatabaseObservations,
          targetDatabaseWorkload,
        }),
      );
    }
  } catch (error) {
    benchmarkFailed = true;
    benchmarkError = error;
  }
  const cleanupErrors = [];
  if (databaseSampler !== undefined)
    try {
      databaseObservations = await databaseSampler.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
  if (monitorEnabled)
    try {
      lag.disable();
    } catch (error) {
      cleanupErrors.push(error);
    }
  clearTimeout(deadline);
  if (deadlineError !== undefined) {
    if (activeTermination !== undefined)
      try {
        await activeTermination;
      } catch (error) {
        cleanupErrors.push(error);
      }
    if (benchmarkFailed && benchmarkError !== deadlineError)
      benchmarkError = new AggregateError(
        [deadlineError, benchmarkError],
        'Benchmark deadline elapsed during workload execution',
      );
    else {
      benchmarkFailed = true;
      benchmarkError = deadlineError;
    }
  }
  if (benchmarkFailed && cleanupErrors.length > 0)
    throw new AggregateError(
      [benchmarkError, ...cleanupErrors],
      'Benchmark failed and resource cleanup was incomplete',
    );
  if (benchmarkFailed) throw benchmarkError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1)
    throw new AggregateError(
      cleanupErrors,
      'Benchmark resource cleanup failed',
    );
  const postgresEvidence = await (
    options.capturePostgresEvidence ?? capturePostgresEvidence
  )(benchmarkEnvironment);
  const pnpm = await run('pnpm', ['--version']);
  const buildCompleted = await (options.buildIdentity ?? buildOutputIdentity)();
  const sourceCompleted = await identifySource({ excludedPaths });
  const sourceStable =
    sourceStarted.workingTreeSha256 === sourceCompleted.workingTreeSha256;
  const buildStable =
    buildStarted.outputSha256 === buildCompleted.outputSha256 &&
    buildStarted.fileCount === buildCompleted.fileCount;
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
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    status: sourceStable && buildStable ? 'complete' : 'partial',
    recordedAt: new Date().toISOString(),
    source: {
      started: sourceStarted,
      afterBuild: sourceAfterBuild,
      completed: sourceCompleted,
      stable: sourceStable,
    },
    build: {
      command: 'pnpm build',
      qualifiedSourceSha256: sourceStarted.workingTreeSha256,
      started: buildStarted,
      completed: buildCompleted,
      stable: buildStable,
    },
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
  const reservation = await reserveBenchmarkEvidence(outputFile);
  let primaryFailed = false;
  let primaryError;
  try {
    const evidence = await benchmark(manifest, process.env, {
      excludedSourcePaths: [reservation.path],
    });
    if (receivedSignal) throw new Error(`Interrupted by ${receivedSignal}`);
    await reservation.complete(evidence);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
    try {
      await reservation.abandon();
    } catch (cleanupError) {
      primaryError = new AggregateError(
        [error, cleanupError],
        'Benchmark failed and its output reservation cleanup was incomplete',
      );
    }
  }
  let cleanupFailed = false;
  let cleanupError;
  try {
    await requestOwnedProcessTermination();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (primaryFailed && cleanupFailed)
    throw new AggregateError(
      [primaryError, cleanupError],
      'Benchmark failed and owned process cleanup was incomplete',
    );
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
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
