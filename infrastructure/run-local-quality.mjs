#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream, readFileSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { finished } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import {
  OwnedProcessSupervisor,
  runManagedCommand,
  terminateProcessTree,
} from './owned-process-tree.mjs';
import { validateVitestGateReport } from './validate-vitest-gate-report.mjs';
import { validateBenchmarkEvidence } from './performance/compare-local-benchmark.mjs';

export { terminateProcessTree };

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const localQualityStateRoot =
  process.env.NODE_ENV === 'test' &&
  process.env.PERTEXO_LOCAL_QUALITY_TEST_STATE_DIRECTORY !== undefined
    ? path.resolve(process.env.PERTEXO_LOCAL_QUALITY_TEST_STATE_DIRECTORY)
    : path.join(repositoryRoot, 'coverage');
const serviceCohorts = new Set([
  'mutation-sensitivity',
  'performance',
  'integration-artifact-store',
  'integration-queue',
  'integration-database',
  'integration-worker',
  'integration-api',
  'recovery-worker',
  'sse-resilience',
  'worker-transport-resilience',
  'api-compatibility',
  'database-compatibility',
]);

export const LOCAL_QUALITY_COHORTS = Object.freeze([
  Object.freeze({ id: 'prerequisites', internal: 'prerequisites' }),
  Object.freeze({ id: 'quality', command: ['pnpm', 'check'] }),
  Object.freeze({ id: 'coverage', command: ['pnpm', 'test:coverage'] }),
  Object.freeze({ id: 'services', internal: 'services' }),
  Object.freeze({ id: 'migration', internal: 'migration' }),
  Object.freeze({
    id: 'mutation-sensitivity',
    command: ['node', 'infrastructure/verify-mutation-sensitivity.mjs'],
  }),
  Object.freeze({ id: 'performance', internal: 'performance' }),
  Object.freeze({
    id: 'integration-artifact-store',
    report: { minimumTests: 5, expectedPendingTests: 3 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/artifact-store',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
    ],
  }),
  Object.freeze({
    id: 'integration-queue',
    report: { minimumTests: 1, expectedPendingTests: 0 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/queue',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
    ],
  }),
  Object.freeze({
    id: 'integration-database',
    report: { minimumTests: 383, expectedPendingTests: 0 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/database',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration-coverage.config.ts',
      '--coverage',
    ],
    after: [
      ['pnpm', '--filter', '@pertexo/database', 'test:coverage'],
      ['pnpm', 'database:coverage:merge'],
    ],
  }),
  Object.freeze({
    id: 'integration-worker',
    report: { minimumTests: 30, expectedPendingTests: 0 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/worker',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
    ],
  }),
  Object.freeze({
    id: 'integration-api',
    report: { minimumTests: 32, expectedPendingTests: 0 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/api',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      '--exclude',
      'test/platform/compatibility-rollout.integration.test.ts',
    ],
  }),
  Object.freeze({
    id: 'recovery-worker',
    report: { minimumTests: 4, expectedPendingTests: 0 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/worker',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      'test/coordinator-consumer-retry-wait.integration.test.ts',
      'test/coordinator-consumer-parallel-recovery.integration.test.ts',
      'test/coordinator-consumer-foreach-cancellation.integration.test.ts',
      'test/http-node-attempt.integration.test.ts',
    ],
  }),
  Object.freeze({
    id: 'sse-resilience',
    report: { minimumTests: 1, expectedPendingTests: 0 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/api',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.sse-resilience.config.ts',
    ],
  }),
  Object.freeze({
    id: 'worker-transport-resilience',
    report: { minimumTests: 1, expectedPendingTests: 0 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/worker',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.resilience.config.ts',
    ],
  }),
  Object.freeze({
    id: 'api-compatibility',
    report: { minimumTests: 1, expectedPendingTests: 0 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/api',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.compatibility-rollout.config.ts',
    ],
  }),
  Object.freeze({
    id: 'database-compatibility',
    report: { minimumTests: 1, expectedPendingTests: 0 },
    command: [
      'pnpm',
      '--filter',
      '@pertexo/database',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      'test/oidc-browser-binding-migration.integration.test.ts',
    ],
  }),
  Object.freeze({ id: 'deployment', command: ['pnpm', 'deployment:check'] }),
  Object.freeze({ id: 'images', command: ['pnpm', 'images:check'] }),
  Object.freeze({ id: 'exercises', command: ['pnpm', 'exercise:check'] }),
  Object.freeze({ id: 'cleanup', internal: 'cleanup' }),
]);

export const AWS_ONLY_EXCLUSIONS = Object.freeze([
  Object.freeze({
    id: 'aws-control-ledger-dual-service',
    test: 'proves real dual-service append, replay, conflict, and retry repair',
    reason:
      'requires AWS S3 Object Lock and bucket-policy behavior that the local MinIO fixtures do not claim to reproduce',
  }),
  Object.freeze({
    id: 'aws-control-ledger-primary-conditional-create',
    test: 'enforces immutable conditional creation in primary',
    reason: 'requires AWS enforcement of the production primary bucket policy',
  }),
  Object.freeze({
    id: 'aws-control-ledger-recovery-conditional-create',
    test: 'enforces immutable conditional creation in recovery',
    reason: 'requires AWS enforcement of the production recovery bucket policy',
  }),
]);

const requiredServiceFlags = Object.freeze({
  API_ARTIFACT_INTEGRATION: 'true',
  API_COMPATIBILITY_ROLLOUT_INTEGRATION: 'true',
  API_IDENTITY_INTEGRATION: 'true',
  API_SSE_INTEGRATION: 'true',
  API_SSE_RESILIENCE_INTEGRATION: 'true',
  API_WEBHOOK_INTEGRATION: 'true',
  ARTIFACT_STORE_INTEGRATION: 'true',
  CONTROL_LEDGER_INTEGRATION: 'true',
  CONTROL_LEDGER_INTEGRATION_PROVIDER: 'minio',
  QUEUE_INTEGRATION: 'true',
  REDIS_RATE_LIMIT_INTEGRATION: 'true',
  WORKER_TRANSPORT_INTEGRATION: 'true',
  WORKER_TRANSPORT_RESILIENCE: 'true',
  WORKER_TRIGGER_INTEGRATION: 'true',
});

const requiredCiEnvironment = Object.freeze([
  'POSTGRES_SUPERUSER_PASSWORD',
  'POSTGRES_MIGRATION_PASSWORD',
  'POSTGRES_MAINTENANCE_PASSWORD',
  'POSTGRES_LIFECYCLE_COMMAND_PASSWORD',
  'POSTGRES_API_RUNTIME_PASSWORD',
  'POSTGRES_WORKER_RUNTIME_PASSWORD',
  'POSTGRES_DISPATCHER_RUNTIME_PASSWORD',
  'REDIS_PASSWORD',
]);

export function parseArguments(arguments_) {
  const normalized = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;
  if (normalized.length === 0) return { mode: 'qualification', selected: null };
  if (normalized.length === 2 && normalized[0] === '--partial') {
    const selected = new Set(normalized[1].split(',').filter(Boolean));
    if (selected.size === 0) throw new Error('--partial requires cohort names');
    const known = new Set(LOCAL_QUALITY_COHORTS.map(({ id }) => id));
    for (const id of selected) {
      if (!known.has(id))
        throw new Error(`Unknown local quality cohort: ${id}`);
      const definition = LOCAL_QUALITY_COHORTS.find(
        ({ id: cohortId }) => cohortId === id,
      );
      if (
        definition?.internal !== undefined &&
        definition.internal !== 'performance'
      )
        throw new Error(
          `The ${id} internal cohort cannot be selected directly`,
        );
    }
    return { mode: 'partial', selected };
  }
  throw new Error('usage: pnpm quality:local [--partial cohort[,cohort...]]');
}

function logicalShellCommands(script) {
  return script
    .replaceAll(/\\\s*\n\s*/gu, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizedVitestCommand(command) {
  return command
    .split(/\s+/u)
    .filter(
      (token) =>
        token !== '--reporter=json' && !token.startsWith('--outputFile='),
    )
    .join(' ');
}

function ciVitestCommands(parsed) {
  return Object.entries(parsed.jobs ?? {})
    .filter(([name]) =>
      ['integration', 'recovery', 'compatibility'].includes(name),
    )
    .flatMap(([, job]) => job.steps ?? [])
    .flatMap((step) =>
      typeof step.run === 'string' ? logicalShellCommands(step.run) : [],
    )
    .filter(
      (command) =>
        command.startsWith('pnpm --filter ') &&
        command.includes(' exec vitest run '),
    )
    .map(normalizedVitestCommand)
    .sort();
}

function expectedCiVitestCommands() {
  return LOCAL_QUALITY_COHORTS.filter(
    ({ id, report }) => serviceCohorts.has(id) && report !== undefined,
  )
    .map(({ command }) => command.join(' '))
    .sort();
}

const expectedCiServiceLifecycleCommands = Object.freeze(
  [
    'docker compose run --rm control-ledger-primary-bootstrap',
    'docker compose run --rm control-ledger-recovery-bootstrap',
    'docker compose up -d --wait postgres',
    'docker compose up -d --wait postgres redis artifact-store control-ledger-primary control-ledger-recovery',
    'docker compose up -d --wait postgres redis artifact-store control-ledger-primary control-ledger-recovery',
    'pnpm --filter @pertexo/database test:coverage',
    'pnpm database:coverage:merge',
    'pnpm db:migrate',
    'pnpm db:migrate',
    'node infrastructure/verify-mutation-sensitivity.mjs',
  ].sort(),
);

function ciServiceLifecycleCommands(parsed) {
  return Object.entries(parsed.jobs ?? {})
    .filter(([name]) =>
      ['integration', 'recovery', 'compatibility'].includes(name),
    )
    .flatMap(([, job]) => job.steps ?? [])
    .flatMap((step) =>
      typeof step.run === 'string' ? logicalShellCommands(step.run) : [],
    )
    .filter(
      (command) =>
        command.startsWith('docker compose up ') ||
        command.startsWith('docker compose run --rm control-ledger-') ||
        command === 'pnpm --filter @pertexo/database test:coverage' ||
        command === 'pnpm database:coverage:merge' ||
        command === 'pnpm db:migrate' ||
        command === 'node infrastructure/verify-mutation-sensitivity.mjs',
    )
    .sort();
}

function environmentDeclarations(parsed, name) {
  const declarations = [];
  const visit = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (
      value.env !== null &&
      typeof value.env === 'object' &&
      name in value.env
    )
      declarations.push(String(value.env[name]));
    for (const child of Object.values(value)) visit(child);
  };
  visit(parsed);
  return declarations;
}

export function assertCiLocalQualityContract(source) {
  const parsed = parseYaml(source);
  if (parsed === null || typeof parsed !== 'object' || parsed.env === undefined)
    throw new Error('CI must define the shared local service environment');
  for (const name of requiredCiEnvironment)
    if (typeof parsed.env[name] !== 'string' || parsed.env[name].length === 0)
      throw new Error(`CI service environment is missing ${name}`);
  for (const [name, value] of Object.entries(requiredServiceFlags)) {
    const declarations = environmentDeclarations(parsed, name);
    if (
      declarations.length === 0 ||
      declarations.some((declared) => declared !== value)
    )
      throw new Error(`CI service environment is missing ${name}=${value}`);
  }
  const actualCommands = ciVitestCommands(parsed);
  const expectedCommands = expectedCiVitestCommands();
  if (JSON.stringify(actualCommands) !== JSON.stringify(expectedCommands))
    throw new Error(
      `CI/local quality Vitest commands diverged: expected ${JSON.stringify(expectedCommands)}, found ${JSON.stringify(actualCommands)}`,
    );
  const actualLifecycleCommands = ciServiceLifecycleCommands(parsed);
  if (
    JSON.stringify(actualLifecycleCommands) !==
    JSON.stringify(expectedCiServiceLifecycleCommands)
  )
    throw new Error(
      `CI/local quality service lifecycle diverged: expected ${JSON.stringify(expectedCiServiceLifecycleCommands)}, found ${JSON.stringify(actualLifecycleCommands)}`,
    );
  const cleanupCommands = Object.values(parsed.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter(
      (step) =>
        step.name?.startsWith('Stop disposable') &&
        step.if === 'always()' &&
        step.run === 'docker compose down -v --remove-orphans',
    );
  if (cleanupCommands.length !== 3)
    throw new Error('CI service jobs must retain three exact owned cleanups');
  return Object.fromEntries(
    Object.entries(parsed.env).map(([name, value]) => [name, String(value)]),
  );
}

export function assertQualificationEnvironment(environment) {
  for (const [name, expected] of Object.entries(requiredServiceFlags))
    if (environment[name] !== expected)
      throw new Error(
        `Local qualification requires ${name}=${expected}; refusing a silently skipped cohort`,
      );
}

export function validateQualificationManifest(manifest) {
  if (manifest.mode !== 'qualification')
    throw new Error('Exploratory partial runs are not qualification evidence');
  if (manifest.source?.stable !== true)
    throw new Error('Qualification source evidence is stale');
  for (const definition of LOCAL_QUALITY_COHORTS) {
    const matches = manifest.cohorts.filter(({ id }) => id === definition.id);
    if (matches.length !== 1)
      throw new Error(
        `Qualification manifest must contain local cohort ${definition.id} exactly once`,
      );
    const [cohort] = matches;
    if (cohort.required && cohort.status !== 'passed')
      throw new Error(
        `Required local cohort ${cohort.id} is ${cohort.status ?? 'missing'}`,
      );
    if (
      cohort.required &&
      cohort.reportExpected &&
      cohort.reportValidated !== true
    )
      throw new Error(
        `Required local cohort ${cohort.id} has no complete report`,
      );
  }
  for (const exclusion of AWS_ONLY_EXCLUSIONS) {
    const matches = manifest.externalExclusions?.filter(
      ({ id }) => id === exclusion.id,
    );
    if (matches?.length !== 1 || matches[0].status !== 'skipped')
      throw new Error(
        `Qualification manifest must retain named AWS-only exclusion ${exclusion.id}`,
      );
  }
  return manifest;
}

export async function acquireRunLock(lockPath, owner) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const existingOwner = await readFile(lockPath, 'utf8').catch(
        () => 'unreadable owner',
      );
      throw new Error(
        `Another local quality run owns ${lockPath} (${existingOwner.trim()}); coverage outputs are intentionally serialized`,
      );
    }
    throw error;
  }
  await handle.writeFile(`${JSON.stringify(owner)}\n`);
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const current = JSON.parse(await readFile(lockPath, 'utf8'));
    if (current.token !== owner.token)
      throw new Error('Local quality lock ownership changed before release');
    await rm(lockPath);
  };
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback service port'));
        return;
      }
      resolve({
        port: address.port,
        release: () =>
          new Promise((done, closeReject) => {
            server.close((error) => (error ? closeReject(error) : done()));
          }),
      });
    });
  });
}

export async function reserveAvailablePorts(count) {
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error('Port reservation count must be a positive integer');
  const reservations = [];
  try {
    for (let index = 0; index < count; index += 1)
      reservations.push(await reservePort());
    if (new Set(reservations.map(({ port }) => port)).size !== count)
      throw new Error('Dynamic service ports must be unique');
    return reservations;
  } catch (error) {
    await Promise.allSettled(reservations.map(({ release }) => release()));
    throw error;
  }
}

function composeArguments(project, ...arguments_) {
  return ['compose', '-p', project, '-f', 'compose.yaml', ...arguments_];
}

function sourceIdentity(environment) {
  return Promise.all([
    capture('git', ['rev-parse', 'HEAD'], environment),
    capture('git', ['status', '--porcelain=v1', '-z'], environment),
    capture('git', ['diff', '--binary', 'HEAD'], environment),
    capture(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      environment,
    ),
  ]).then(async ([head, status, diff, untracked]) => {
    const hash = createHash('sha256');
    hash.update(head.stdout);
    hash.update(diff.stdout);
    const untrackedFiles = untracked.stdout.split('\0').filter(Boolean).sort();
    for (const file of untrackedFiles) {
      hash.update(file);
      hash.update(await readFile(path.join(repositoryRoot, file)));
    }
    return {
      head: head.stdout.trim(),
      dirty: status.stdout.length > 0,
      fingerprint: hash.digest('hex'),
      status: status.stdout.split('\0').filter(Boolean),
    };
  });
}

async function capture(command, arguments_, environment) {
  let stdout = '';
  let stderr = '';
  await runManagedCommand({
    args: arguments_,
    command,
    failure: (code, signal) =>
      new Error(
        `${command} ${arguments_.join(' ')} failed (${signal ?? String(code)}): ${stderr || stdout}`,
      ),
    onStarted: (child) => {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
    },
    onStdout: (chunk) => (stdout += chunk),
    onStderr: (chunk) => (stderr += chunk),
    releaseOwned: processSupervisor.release.bind(processSupervisor),
    spawnOwned: processSupervisor.spawn.bind(processSupervisor),
    spawnOptions: {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  });
  return { stdout, stderr };
}

export function createRunId() {
  return `${new Date().toISOString().toLowerCase().replaceAll(/[:.]/gu, '-')}-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
}

function localEnvironment(ciEnvironment, ports, project) {
  const [postgres, redis, artifact, ledgerPrimary, ledgerRecovery] = ports;
  const database = (user, password, name = 'pertexo') =>
    `postgresql://${user}:${password}@127.0.0.1:${String(postgres)}/${name}`;
  return {
    ...process.env,
    ...ciEnvironment,
    ...requiredServiceFlags,
    COMPOSE_PROJECT_NAME: project,
    POSTGRES_PORT: String(postgres),
    REDIS_PORT: String(redis),
    ARTIFACT_STORE_PORT: String(artifact),
    CONTROL_LEDGER_PORT: String(ledgerPrimary),
    CONTROL_LEDGER_RECOVERY_PORT: String(ledgerRecovery),
    POSTGRES_OPERATOR_PASSWORD: 'pertexo-local-operator',
    DATABASE_ADMIN_URL: database(
      'postgres',
      ciEnvironment.POSTGRES_SUPERUSER_PASSWORD,
      'postgres',
    ),
    DATABASE_MIGRATION_URL: database(
      'pertexo_migration',
      ciEnvironment.POSTGRES_MIGRATION_PASSWORD,
    ),
    DATABASE_MAINTENANCE_URL: database(
      'pertexo_maintenance',
      ciEnvironment.POSTGRES_MAINTENANCE_PASSWORD,
    ),
    DATABASE_OPERATOR_URL: database(
      'pertexo_operator',
      'pertexo-local-operator',
    ),
    DATABASE_LIFECYCLE_COMMAND_URL: database(
      'pertexo_lifecycle_command',
      ciEnvironment.POSTGRES_LIFECYCLE_COMMAND_PASSWORD,
    ),
    DATABASE_API_URL: database(
      'pertexo_api',
      ciEnvironment.POSTGRES_API_RUNTIME_PASSWORD,
    ),
    DATABASE_WORKER_URL: database(
      'pertexo_worker',
      ciEnvironment.POSTGRES_WORKER_RUNTIME_PASSWORD,
    ),
    DATABASE_DISPATCHER_URL: database(
      'pertexo_dispatcher',
      ciEnvironment.POSTGRES_DISPATCHER_RUNTIME_PASSWORD,
    ),
    REDIS_URL: `redis://:${ciEnvironment.REDIS_PASSWORD}@127.0.0.1:${String(redis)}/0`,
    ARTIFACT_STORE_ENDPOINT: `http://127.0.0.1:${String(artifact)}`,
    ARTIFACT_STORE_RECOVERY_ENDPOINT: `http://127.0.0.1:${String(artifact)}`,
    CONTROL_LEDGER_ENDPOINT: `http://127.0.0.1:${String(ledgerPrimary)}`,
    CONTROL_LEDGER_RECOVERY_ENDPOINT: `http://127.0.0.1:${String(ledgerRecovery)}`,
  };
}

function selectedCohorts(options) {
  const selected =
    options.selected ?? new Set(LOCAL_QUALITY_COHORTS.map(({ id }) => id));
  selected.add('prerequisites');
  if ([...selected].some((id) => serviceCohorts.has(id))) {
    selected.add('services');
    selected.add('migration');
    selected.add('cleanup');
  }
  return selected;
}

function initialManifest(id, options, selected, source) {
  return {
    schemaVersion: 1,
    runId: id,
    mode: options.mode,
    startedAt: new Date().toISOString(),
    source: { started: source },
    cohorts: LOCAL_QUALITY_COHORTS.map(({ id: cohortId, report }) => ({
      id: cohortId,
      required: options.mode === 'qualification',
      reportExpected: report !== undefined,
      status: selected.has(cohortId) ? 'expected' : 'skipped',
      ...(selected.has(cohortId)
        ? {}
        : { reason: 'not selected in exploratory partial run' }),
    })),
    externalExclusions: AWS_ONLY_EXCLUSIONS.map((exclusion) => ({
      ...exclusion,
      status: 'skipped',
    })),
  };
}

async function writeManifest(file, manifest) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, file);
}

function cohortRecord(manifest, id) {
  const record = manifest.cohorts.find((cohort) => cohort.id === id);
  if (!record) throw new Error(`Unknown manifest cohort ${id}`);
  return record;
}

const processSupervisor = new OwnedProcessSupervisor();
let activeTermination;
let receivedSignal;

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
  // Signal and stream-error handlers cannot await cleanup directly. Retain the
  // promise for the guarded cleanup path while marking rejection as observed.
  void activeTermination.catch(() => undefined);
  return activeTermination;
}

export async function execute(
  command,
  arguments_,
  environment,
  logFile,
  dependencies = {},
) {
  const log = (dependencies.createLogStream ?? createWriteStream)(logFile, {
    flags: 'a',
  });
  const logCompletion = finished(log).then(
    () => ({ error: undefined, failed: false }),
    (error) => ({ error, failed: true }),
  );
  let completionFailed = false;
  let completionError;
  try {
    await runManagedCommand({
      args: arguments_,
      command,
      failure: (code, signal) =>
        new Error(
          `${command} ${arguments_.join(' ')} failed with ${signal ?? `exit ${String(code)}`}`,
        ),
      onStarted: () => {
        log.once('error', () => {
          (dependencies.requestTermination ?? requestOwnedProcessTermination)();
        });
      },
      onStdout: (chunk) => {
        process.stdout.write(chunk);
        log.write(chunk);
      },
      onStderr: (chunk) => {
        process.stderr.write(chunk);
        log.write(chunk);
      },
      releaseOwned:
        dependencies.releaseOwned ??
        processSupervisor.release.bind(processSupervisor),
      spawnOwned:
        dependencies.spawnOwned ??
        processSupervisor.spawn.bind(processSupervisor),
      spawnOptions: {
        cwd: repositoryRoot,
        env: environment,
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    });
  } catch (error) {
    completionFailed = true;
    completionError = error;
  }
  let logEndFailed = false;
  let logEndError;
  try {
    log.end();
  } catch (error) {
    logEndFailed = true;
    logEndError = error;
  }
  const logFailure = logEndFailed
    ? { error: logEndError, failed: true }
    : await logCompletion;
  if (completionFailed && logFailure.failed)
    throw new AggregateError(
      [completionError, logFailure.error],
      `${command} ${arguments_.join(' ')} failed and its evidence log was incomplete`,
    );
  if (completionFailed) throw completionError;
  if (logFailure.failed) throw logFailure.error;
}

async function assertCommands(environment, needsDocker) {
  await capture('pnpm', ['--version'], environment);
  if (needsDocker) await capture('docker', ['compose', 'version'], environment);
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error(
      `Local qualification requires Node 24; found ${process.version}`,
    );
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const selected = selectedCohorts(options);
  const needsDocker = [...selected].some((id_) => serviceCohorts.has(id_));
  const id = createRunId();
  const outputDirectory = path.join(localQualityStateRoot, 'local-quality', id);
  const reportsDirectory = path.join(outputDirectory, 'reports');
  const manifestPath = path.join(outputDirectory, 'manifest.json');
  const lockPath = path.join(localQualityStateRoot, '.local-quality.lock');
  const lockOwner = {
    pid: process.pid,
    runId: id,
    token: randomBytes(16).toString('hex'),
  };
  let releaseLock;
  let reservations = [];
  let environment = process.env;
  let servicesStarted = false;
  let manifest;
  let primaryFailed = false;
  let primaryError;

  process.once('exit', () => {
    processSupervisor.killAllSync();
    if (servicesStarted)
      spawnSync(
        'docker',
        composeArguments(lockOwner.runId, 'down', '-v', '--remove-orphans'),
        {
          cwd: repositoryRoot,
          env: environment,
          stdio: 'ignore',
          timeout: 60_000,
        },
      );
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current.token === lockOwner.token) rmSync(lockPath);
    } catch {
      // The normal asynchronous cleanup already removed or never owned it.
    }
  });

  const cleanup = async (release = true) => {
    const failures = [];
    try {
      await requestOwnedProcessTermination();
    } catch (error) {
      failures.push(error);
    }
    const reservationResults = await Promise.allSettled(
      reservations.map(({ release }) => release()),
    );
    failures.push(
      ...reservationResults.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      ),
    );
    reservations = [];
    if (servicesStarted) {
      try {
        const status = await capture(
          'docker',
          composeArguments(lockOwner.runId, 'ps', '--all'),
          environment,
        );
        await writeFile(
          path.join(outputDirectory, 'service-status.log'),
          status.stdout,
        );
        const logs = await capture(
          'docker',
          composeArguments(
            lockOwner.runId,
            'logs',
            '--no-color',
            '--timestamps',
          ),
          environment,
        );
        await writeFile(
          path.join(outputDirectory, 'service-logs.log'),
          logs.stdout,
        );
      } catch (error) {
        failures.push(error);
        try {
          await writeFile(
            path.join(outputDirectory, 'cleanup-diagnostics.log'),
            `${error instanceof Error ? error.stack : String(error)}\n`,
          );
        } catch (diagnosticError) {
          failures.push(diagnosticError);
        }
      }
      try {
        await capture(
          'docker',
          composeArguments(lockOwner.runId, 'down', '-v', '--remove-orphans'),
          environment,
        );
        servicesStarted = false;
      } catch (error) {
        failures.push(error);
      }
    }
    if (release && releaseLock)
      try {
        await releaseLock();
        releaseLock = undefined;
      } catch (error) {
        failures.push(error);
      }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Local quality cleanup failed');
  };

  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      receivedSignal = signal;
      requestOwnedProcessTermination(signal);
    });

  try {
    await mkdir(reportsDirectory, { recursive: true });
    releaseLock = await acquireRunLock(lockPath, lockOwner);
    const ciSource = await readFile(
      path.join(repositoryRoot, '.github/workflows/ci.yml'),
      'utf8',
    );
    const ciEnvironment = assertCiLocalQualityContract(ciSource);
    manifest = initialManifest(
      id,
      options,
      selected,
      await sourceIdentity(process.env),
    );
    await writeManifest(manifestPath, manifest);

    for (const definition of LOCAL_QUALITY_COHORTS) {
      const record = cohortRecord(manifest, definition.id);
      if (!selected.has(definition.id)) continue;
      if (receivedSignal) throw new Error(`Interrupted by ${receivedSignal}`);
      record.startedAt = new Date().toISOString();
      await writeManifest(manifestPath, manifest);
      try {
        if (definition.internal === 'prerequisites') {
          await assertCommands(process.env, needsDocker);
          if (needsDocker) reservations = await reserveAvailablePorts(5);
          environment = needsDocker
            ? localEnvironment(
                ciEnvironment,
                reservations.map(({ port }) => port),
                id,
              )
            : { ...process.env, ...ciEnvironment };
          if (options.mode === 'qualification')
            assertQualificationEnvironment(environment);
        } else if (definition.internal === 'services') {
          await Promise.all(reservations.map(({ release }) => release()));
          reservations = [];
          servicesStarted = true;
          await execute(
            'docker',
            composeArguments(
              id,
              'up',
              '-d',
              '--wait',
              'postgres',
              'redis',
              'artifact-store',
              'control-ledger-primary',
              'control-ledger-recovery',
            ),
            environment,
            path.join(outputDirectory, `${definition.id}.log`),
          );
          for (const [service, containerPort, hostPort] of [
            ['postgres', '5432', environment.POSTGRES_PORT],
            ['redis', '6379', environment.REDIS_PORT],
            ['artifact-store', '9090', environment.ARTIFACT_STORE_PORT],
            ['control-ledger-primary', '9000', environment.CONTROL_LEDGER_PORT],
            [
              'control-ledger-recovery',
              '9000',
              environment.CONTROL_LEDGER_RECOVERY_PORT,
            ],
          ]) {
            const mapping = await capture(
              'docker',
              composeArguments(id, 'port', service, containerPort),
              environment,
            );
            if (mapping.stdout.trim() !== `127.0.0.1:${hostPort}`)
              throw new Error(
                `${service} did not bind its validated loopback port ${hostPort}`,
              );
          }
          await execute(
            'docker',
            composeArguments(
              id,
              'run',
              '--rm',
              'control-ledger-primary-bootstrap',
            ),
            environment,
            path.join(outputDirectory, `${definition.id}.log`),
          );
          await execute(
            'docker',
            composeArguments(
              id,
              'run',
              '--rm',
              'control-ledger-recovery-bootstrap',
            ),
            environment,
            path.join(outputDirectory, `${definition.id}.log`),
          );
        } else if (definition.internal === 'migration') {
          await execute(
            'pnpm',
            ['db:migrate'],
            environment,
            path.join(outputDirectory, `${definition.id}.log`),
          );
        } else if (definition.internal === 'performance') {
          const evidencePath = path.join(
            outputDirectory,
            'local-performance.json',
          );
          await execute(
            process.execPath,
            [
              'infrastructure/performance/run-local-benchmark.mjs',
              'infrastructure/performance/local-benchmark-manifest.json',
              evidencePath,
            ],
            { ...environment, PERTEXO_Q11_ISOLATED: '1' },
            path.join(outputDirectory, `${definition.id}.log`),
          );
          validateBenchmarkEvidence(
            JSON.parse(await readFile(evidencePath, 'utf8')),
            'Qualification benchmark',
          );
          record.evidence = path.relative(repositoryRoot, evidencePath);
        } else if (definition.internal === 'cleanup') {
          await cleanup(false);
        } else {
          const reportPath = definition.report
            ? path.join(reportsDirectory, `${definition.id}.json`)
            : undefined;
          const command = definition.command;
          const arguments_ = [
            ...command.slice(1),
            ...(reportPath
              ? ['--reporter=json', `--outputFile=${reportPath}`]
              : []),
          ];
          const reportProducerStartedAt = reportPath ? Date.now() : undefined;
          await execute(
            command[0],
            arguments_,
            environment,
            path.join(outputDirectory, `${definition.id}.log`),
          );
          const reportProducerCompletedAt = reportPath ? Date.now() : undefined;
          for (const after of definition.after ?? [])
            await execute(
              after[0],
              after.slice(1),
              environment,
              path.join(outputDirectory, `${definition.id}.log`),
            );
          if (reportPath) {
            const report = JSON.parse(await readFile(reportPath, 'utf8'));
            record.result = validateVitestGateReport(
              report,
              definition.id,
              definition.report.minimumTests,
              definition.report.expectedPendingTests,
            );
            record.report = path.relative(repositoryRoot, reportPath);
            record.reportValidated = true;
            if (definition.id === 'integration-worker') {
              const integrationEvidencePath = path.join(
                reportsDirectory,
                `${definition.id}-evidence.json`,
              );
              await execute(
                process.execPath,
                ['infrastructure/report-risk-coverage.mjs'],
                {
                  ...environment,
                  PERTEXO_RISK_COVERAGE_RESULT_FILE: reportPath,
                  PERTEXO_RISK_COVERAGE_EVIDENCE_FILE: integrationEvidencePath,
                  PERTEXO_RISK_COVERAGE_COMMAND: command.join(' '),
                  PERTEXO_RISK_COVERAGE_PRODUCER_STARTED_AT: String(
                    reportProducerStartedAt,
                  ),
                  PERTEXO_RISK_COVERAGE_PRODUCER_COMPLETED_AT: String(
                    reportProducerCompletedAt,
                  ),
                  PERTEXO_RISK_COVERAGE_CANDIDATE_FINGERPRINT:
                    manifest.source.started.fingerprint,
                  PERTEXO_RISK_COVERAGE_RUN_ID: id,
                  ...(options.mode === 'qualification'
                    ? { PERTEXO_RISK_COVERAGE_REQUIRE_EXECUTED: '1' }
                    : {}),
                },
                path.join(outputDirectory, `${definition.id}.log`),
              );
              record.evidence = path.relative(
                repositoryRoot,
                integrationEvidencePath,
              );
            }
          }
        }
        record.status = 'passed';
        record.completedAt = new Date().toISOString();
        await writeManifest(manifestPath, manifest);
      } catch (error) {
        record.status = 'failed';
        record.completedAt = new Date().toISOString();
        record.reason = error instanceof Error ? error.message : String(error);
        for (const remaining of manifest.cohorts)
          if (remaining.status === 'expected') {
            remaining.status = 'skipped';
            remaining.reason = `blocked by failed cohort ${definition.id}`;
          }
        manifest.completedAt = new Date().toISOString();
        manifest.outcome = 'failed';
        await writeManifest(manifestPath, manifest);
        throw error;
      }
    }
    // A qualification is not successful until owned services, volumes, port
    // reservations, and the checkout lock have all been released. Keep this
    // inside the guarded outcome path so cleanup failures are persisted as a
    // failed manifest instead of leaving a misleading passed artifact.
    await cleanup();
    manifest.source.completed = await sourceIdentity(process.env);
    manifest.source.stable =
      manifest.source.started.fingerprint ===
      manifest.source.completed.fingerprint;
    if (options.mode === 'qualification' && !manifest.source.stable)
      throw new Error('Checkout changed during local qualification');
    manifest.completedAt = new Date().toISOString();
    if (receivedSignal) throw new Error(`Interrupted by ${receivedSignal}`);
    manifest.outcome = options.mode === 'qualification' ? 'passed' : 'partial';
    if (options.mode === 'qualification')
      validateQualificationManifest(manifest);
    await writeManifest(manifestPath, manifest);
    process.stdout.write(
      `Local quality ${manifest.outcome}: ${manifestPath}\n`,
    );
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
    try {
      if (manifest) {
        if (manifest.source.completed === undefined) {
          const completedSource = await sourceIdentity(process.env).catch(
            () => undefined,
          );
          if (completedSource) {
            manifest.source.completed = completedSource;
            manifest.source.stable =
              manifest.source.started.fingerprint ===
              completedSource.fingerprint;
          }
        }
        if (manifest.outcome === undefined) {
          const unfinished = manifest.cohorts.filter(
            ({ status }) => status === 'expected',
          );
          const failed = unfinished[0] ?? manifest.cohorts.at(-1);
          const skipped = unfinished.slice(1);
          if (failed) {
            failed.status = 'failed';
            failed.reason =
              error instanceof Error ? error.message : String(error);
          }
          for (const skippedCohort of skipped) {
            skippedCohort.status = 'skipped';
            skippedCohort.reason = failed
              ? `blocked by failed cohort ${failed.id}`
              : 'run ended before cohort execution';
          }
          manifest.completedAt = new Date().toISOString();
          manifest.outcome = 'failed';
        }
        await writeManifest(manifestPath, manifest);
      }
    } catch (reportingError) {
      primaryError = new AggregateError(
        [error, reportingError],
        'Local quality failed and its failure manifest could not be written',
      );
    }
  }
  let cleanupFailed = false;
  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (primaryFailed && cleanupFailed)
    throw new AggregateError(
      [primaryError, cleanupError],
      'Local quality failed and cleanup was incomplete',
    );
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  run().catch((error) => {
    process.stderr.write(
      `Local quality run failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = receivedSignal ? 130 : 1;
  });
