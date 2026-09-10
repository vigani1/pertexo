import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

import {
  benchmark,
  closeRunnerOwnedScenarioDatabase,
  createDatabaseWorkloadTracker,
  parseOperationSamples,
  percentile,
  run,
  runWithOwnedDatabaseClient,
  startDatabaseSampler,
  summarize,
  validateManifest,
  writeBenchmarkEvidence,
} from './run-local-benchmark.mjs';
import {
  runPoolContentionSamples,
  validatePostgresEvidence,
} from './postgres-evidence.mjs';
import { validateBenchmarkEvidence } from './compare-local-benchmark.mjs';

const root = path.resolve(import.meta.dirname, '../..');

async function waitForFile(file, timeoutMillis = 5_000) {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 4,
    seed: 42,
    warmupRounds: 1,
    rounds: 3,
    scenarios: [
      {
        name: 'fixture',
        description: 'Bounded fixture',
        concurrency: 1,
        fixturePopulation: { operations: 2 },
        commands: [
          {
            file: process.execPath,
            args: [
              '-e',
              "if (process.env.PERTEXO_BENCHMARK_SEED !== '42') process.exit(2); const origin=performance.timeOrigin; const started=origin+performance.now(); setTimeout(() => { const middle=origin+performance.now(); process.stdout.write('PERTEXO_Q11_OPERATION_V2='+JSON.stringify({schemaVersion:2,name:'fixture-first',startedAtUnixMs:started,endedAtUnixMs:middle,population:1,boundary:'first fixture boundary'})+'\\n'); const ended=origin+performance.now()+7.5; process.stdout.write('PERTEXO_Q11_OPERATION_V2='+JSON.stringify({schemaVersion:2,name:'fixture-second',startedAtUnixMs:middle,endedAtUnixMs:ended,population:1,boundary:'second fixture boundary'})+'\\n'); }, 120)",
            ],
            expectedOperations: [
              {
                name: 'fixture-first',
                count: 1,
                population: 1,
                boundary: 'first fixture boundary',
              },
              {
                name: 'fixture-second',
                count: 1,
                population: 1,
                boundary: 'second fixture boundary',
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

test('calculates nearest-rank latency and variability without inventing a budget', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  assert.deepEqual(summarize([10, 20, 30]), {
    minimum: 10,
    p50: 20,
    p95: 30,
    p99: 30,
    maximum: 30,
    mean: 20,
    standardDeviation: Math.sqrt(200 / 3),
    coefficientOfVariation: Math.sqrt(200 / 3) / 20,
  });
  assert.equal(
    summarize([-10, -20, -30]).coefficientOfVariation,
    Math.sqrt(200 / 3) / 20,
  );
});

test('runner-owned database cleanup always closes the admin client and preserves both failures', async () => {
  const queryError = new Error('drop failed');
  const endError = new Error('client close failed');
  let ended = false;
  const admin = {
    query: async (statement) => {
      if (statement.startsWith('drop database')) throw queryError;
    },
    end: async () => {
      ended = true;
      throw endError;
    },
  };

  await assert.rejects(
    closeRunnerOwnedScenarioDatabase(admin, 'pertexo_q11_owned'),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === queryError &&
      error.errors[1] === endError,
  );
  assert.equal(ended, true);
});

test('partial database client construction preserves connect and close failures', async () => {
  const connectError = new Error('connect failed');
  const endError = new Error('client close failed');
  const client = {
    connect: async () => {
      throw connectError;
    },
    end: async () => {
      throw endError;
    },
  };

  await assert.rejects(
    runWithOwnedDatabaseClient(
      client,
      () => client.connect(),
      'fixture database reset',
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === connectError &&
      error.errors[1] === endError,
  );
});

test('owned database cleanup preserves an undefined operation rejection', async () => {
  let ended = false;
  let rejected = false;
  try {
    await runWithOwnedDatabaseClient(
      {
        end: async () => {
          ended = true;
        },
      },
      () => Promise.reject(undefined),
      'undefined fixture',
    );
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
  assert.equal(ended, true);
});

test('runner-owned database cleanup preserves an undefined query rejection', async () => {
  let ended = false;
  let rejected = false;
  try {
    await closeRunnerOwnedScenarioDatabase(
      {
        query: () => Promise.reject(undefined),
        end: async () => {
          ended = true;
        },
      },
      'pertexo_q11_owned',
    );
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
  assert.equal(ended, true);
});

test('PostgreSQL evidence preserves sampling and pool cleanup failures', async () => {
  const samplingError = new Error('sample failed');
  const cleanupError = new Error('pool cleanup failed');
  let connectCalls = 0;
  let ownerReleased = false;
  await assert.rejects(
    runPoolContentionSamples(
      {
        connect: () => {
          connectCalls += 1;
          return connectCalls === 1
            ? Promise.resolve({ release: () => (ownerReleased = true) })
            : Promise.reject(samplingError);
        },
        end: () => Promise.reject(cleanupError),
      },
      async () => undefined,
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [samplingError, cleanupError]);
      return true;
    },
  );
  assert.equal(ownerReleased, true);
});

test('PostgreSQL evidence releases a sampled client before ending its pool owner', async () => {
  const queryError = new Error('sample query failed');
  let checkedOut = 0;
  let connectCalls = 0;
  const releases = [];
  const pool = {
    connect: async () => {
      const index = connectCalls;
      connectCalls += 1;
      checkedOut += 1;
      return {
        query: async () => {
          throw queryError;
        },
        release: () => {
          checkedOut -= 1;
          releases.push(index);
        },
      };
    },
    end: async () => {
      assert.equal(checkedOut, 0, 'pool.end observed a checked-out client');
    },
  };

  await assert.rejects(
    runPoolContentionSamples(pool, async () => undefined),
    (error) => error === queryError,
  );
  assert.deepEqual(releases, [0, 1]);
});

test('PostgreSQL evidence drains and releases its waiter when sampling delay fails', async () => {
  const waitError = new Error('sampling delay failed');
  let checkedOut = 0;
  const releases = [];
  const pool = {
    connect: async () => {
      const index = checkedOut;
      checkedOut += 1;
      return {
        query: async () => undefined,
        release: () => {
          checkedOut -= 1;
          releases.push(index);
        },
      };
    },
    end: async () => {
      assert.equal(checkedOut, 0, 'pool.end observed a checked-out client');
    },
  };

  await assert.rejects(
    runPoolContentionSamples(pool, async () => {
      throw waitError;
    }),
    (error) => error === waitError,
  );
  assert.deepEqual(releases, [0, 1]);
});

test('PostgreSQL evidence does not mistake an undefined rejection for success', async () => {
  let connectCalls = 0;
  let ended = false;
  let rejected = false;
  try {
    await runPoolContentionSamples(
      {
        connect: async () => {
          connectCalls += 1;
          if (connectCalls === 1) return { release: () => undefined };
          return Promise.reject(undefined);
        },
        end: async () => {
          ended = true;
        },
      },
      async () => undefined,
    );
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
  assert.equal(ended, true);
});

test('parses only named, timestamped, positive operation timing markers', () => {
  const marker = (overrides = {}) =>
    `PERTEXO_Q11_OPERATION_V2=${JSON.stringify({ schemaVersion: 2, name: 'fixture', startedAtUnixMs: 100, endedAtUnixMs: 112.5, population: 1, boundary: 'fixture boundary', ...overrides })}`;
  assert.deepEqual(parseOperationSamples(`stdout | fixture\n${marker()}\n`), [
    {
      name: 'fixture',
      startedAtUnixMs: 100,
      endedAtUnixMs: 112.5,
      durationMs: 12.5,
      population: 1,
      boundary: 'fixture boundary',
      databaseIdentity: undefined,
    },
  ]);
  assert.throws(
    () => parseOperationSamples(`${marker({ endedAtUnixMs: 99 })}\n`),
    /Malformed/u,
  );
});

test('rejects weak, duplicate, or shell-shaped benchmark manifests', () => {
  assert.throws(
    () => validateManifest(manifest({ rounds: 2 })),
    /three measured/u,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({
          scenarios: [manifest().scenarios[0], manifest().scenarios[0]],
        }),
      ),
    /unique/u,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({ scenarios: [{ ...manifest().scenarios[0], name: '  ' }] }),
      ),
    /non-empty/u,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({
          scenarios: [
            {
              ...manifest().scenarios[0],
              commands: [{ file: 'pnpm test', args: '&& true' }],
            },
          ],
        }),
      ),
    /argv array/u,
  );
  const duplicateOperation = manifest();
  duplicateOperation.scenarios[0].commands.push({
    ...duplicateOperation.scenarios[0].commands[0],
    expectedOperations: [
      duplicateOperation.scenarios[0].commands[0].expectedOperations[0],
    ],
  });
  assert.throws(
    () => validateManifest(duplicateOperation),
    /operation names must be unique/u,
  );
});

test('refuses to measure against services not owned by the isolated runner', async () => {
  await assert.rejects(() => benchmark(manifest(), {}), /Q02-owned isolated/u);
});

test('rejects incomplete PostgreSQL role, pool, and plan evidence', () => {
  assert.throws(
    () =>
      validatePostgresEvidence({
        available: true,
        instrumentedSqlRoundTrips: 3,
        poolCheckoutWaitSeconds: [0.05, 0.05, 0.05],
        queryPlans: [],
      }),
    /retention-keyset/u,
  );
  assert.throws(
    () =>
      validatePostgresEvidence({
        available: true,
        instrumentedSqlRoundTrips: 3,
        poolCheckoutWaitSeconds: [0, 0, 0],
        queryPlans: [],
      }),
    /checkout wait/u,
  );
});

test('isolates PostgreSQL workload totals and resets by database OID', async () => {
  const databaseOids = new Map([
    ['base', 11],
    ['target', 22],
  ]);
  const totals = new Map([
    [11, { calls: 0, executionMs: 0 }],
    [22, { calls: 0, executionMs: 0 }],
  ]);
  const statistics = {
    record(databaseOid, calls, executionMs) {
      totals.set(databaseOid, { calls, executionMs });
    },
    async query(statement, parameters = []) {
      if (statement.includes('from pg_database'))
        return {
          rows: [{ database_oid: databaseOids.get(parameters[0]) }],
        };
      if (statement.includes('pg_stat_statements_reset')) {
        if (statement.includes('$1::oid'))
          totals.set(parameters[0], { calls: 0, executionMs: 0 });
        else
          for (const databaseOid of totals.keys())
            totals.set(databaseOid, { calls: 0, executionMs: 0 });
        return { rows: [] };
      }
      if (statement.includes('from pg_stat_statements')) {
        const selected = statement.includes('dbid=$1::oid')
          ? [totals.get(parameters[0])]
          : [...totals.values()];
        return {
          rows: [
            {
              sql_round_trips: selected.reduce(
                (sum, value) => sum + value.calls,
                0,
              ),
              server_execution_ms: selected.reduce(
                (sum, value) => sum + value.executionMs,
                0,
              ),
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
  };
  const base = await createDatabaseWorkloadTracker(statistics, 'base');
  const target = await createDatabaseWorkloadTracker(statistics, 'target');

  await base.beginScenario();
  statistics.record(11, 5, 7.5);
  await target.beginScenario();
  statistics.record(22, 13, 17.5);

  assert.deepEqual(await base.endScenario(), {
    sqlRoundTrips: 5,
    serverExecutionMs: 7.5,
  });
  assert.deepEqual(await target.endScenario(), {
    sqlRoundTrips: 13,
    serverExecutionMs: 17.5,
  });
});

test('closes both PostgreSQL sampler clients when database OID lookup fails', async () => {
  const clients = [];
  class Client {
    constructor() {
      this.connected = false;
      this.closed = false;
      clients.push(this);
    }

    async connect() {
      this.connected = true;
    }

    async query(statement) {
      if (statement.includes('create extension')) return { rows: [] };
      if (statement.includes('from pg_database'))
        throw new Error('database catalog unavailable');
      throw new Error(`Unexpected query: ${statement}`);
    }

    async end() {
      this.closed = true;
    }
  }

  await assert.rejects(
    () =>
      startDatabaseSampler(
        {
          DATABASE_ADMIN_URL: 'postgres://admin@127.0.0.1/postgres',
          DATABASE_MIGRATION_URL: 'postgres://migration@127.0.0.1/pertexo',
        },
        { Client },
      ),
    /database catalog unavailable/u,
  );
  assert.equal(clients.length, 2);
  assert.equal(
    clients.every(({ connected, closed }) => connected && closed),
    true,
  );
});

for (const failingCloseIndexes of [[0], [0, 1]])
  test(`preserves lookup failure with ${String(failingCloseIndexes.length)} PostgreSQL sampler close failure(s)`, async () => {
    const clients = [];
    class Client {
      constructor() {
        this.index = clients.length;
        this.closeAttempted = false;
        clients.push(this);
      }

      async connect() {
        return undefined;
      }

      async query(statement) {
        if (statement.includes('create extension')) return { rows: [] };
        if (statement.includes('from pg_database'))
          throw new Error('database catalog unavailable');
        throw new Error(`Unexpected query: ${statement}`);
      }

      async end() {
        this.closeAttempted = true;
        if (failingCloseIndexes.includes(this.index))
          throw new Error(`close ${String(this.index)} failed`);
      }
    }

    await assert.rejects(
      () =>
        startDatabaseSampler(
          {
            DATABASE_ADMIN_URL: 'postgres://admin@127.0.0.1/postgres',
            DATABASE_MIGRATION_URL: 'postgres://migration@127.0.0.1/pertexo',
          },
          { Client },
        ),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match(error.message, /startup and cleanup failed/u);
        assert.deepEqual(
          error.errors.map(({ message }) => message),
          [
            'database catalog unavailable',
            ...failingCloseIndexes.map(
              (index) => `close ${String(index)} failed`,
            ),
          ],
        );
        return true;
      },
    );
    assert.equal(
      clients.every(({ closeAttempted }) => closeAttempted),
      true,
    );
  });

test('records repeated operation latency, throughput, launcher cost and RSS', async () => {
  const evidence = await benchmark(manifest(), {
    ...process.env,
    DATABASE_ADMIN_URL: '',
    DATABASE_MIGRATION_URL: '',
    PERTEXO_Q11_ISOLATED: '1',
  });
  assert.equal(evidence.scenarios[0].rounds.length, 3);
  assert.equal(evidence.scenarios[0].operationLatencyMs.p95 >= 7.5, true);
  assert.equal(
    evidence.scenarios[0].operationThroughputPerSecond.minimum > 0,
    true,
  );
  assert.equal(evidence.scenarios[0].launcherElapsedMs.p95 >= 120, true);
  assert.equal(
    evidence.scenarios[0].workloadProcessPeakRssBytes.minimum > 0,
    true,
  );
  assert.equal(
    evidence.scenarios[0].rounds.every(
      ({ workloadProcessMetrics }) =>
        workloadProcessMetrics.samples.length > 0 &&
        workloadProcessMetrics.rssTrendBytes !== null,
    ),
    true,
  );
  assert.equal(typeof evidence.source.dirty, 'boolean');
  assert.match(evidence.source.workingTreeSha256, /^[a-f0-9]{64}$/u);
  assert.match(evidence.orchestratorDiagnostics.scope, /orchestrator only/u);
  assert.match(evidence.workloadMetricLimitations.heap, /unavailable/u);
  assert.equal(evidence.databaseObservations.available, false);
  assert.equal(evidence.postgresEvidence.available, false);
});

test('validates and safely owns the actual producer output', async (t) => {
  const summary = (value) => ({
    minimum: value,
    p50: value,
    p95: value,
    p99: value,
    maximum: value,
    mean: value,
    standardDeviation: 0,
    coefficientOfVariation: 0,
  });
  const observations = {
    available: true,
    sampleIntervalMs: 250,
    samples: [
      {
        recordedAt: '2026-09-10T10:00:00.000Z',
        databaseSizeBytes: 10,
        connectionCount: 1,
        activeTaskCount: 1,
        lockWaitCount: 0,
      },
    ],
    databaseSizeBytes: summary(10),
    connectionCount: summary(1),
    activeTaskCount: summary(1),
    lockWaitCount: summary(0),
  };
  const postgresEvidence = {
    available: true,
    poolCheckoutWaitSeconds: [0.05, 0.06, 0.07],
    instrumentedSqlRoundTrips: 1,
    queryPlans: [
      'retention-keyset',
      'artifact-version-listing',
      'purge-discovery',
      'purge-claim',
      'purge-checkpoint',
      'tenant-row-page',
    ].map((name) => ({
      name,
      role: 'pertexo_maintenance',
      plan: { Plan: { 'Node Type': 'Result' }, 'Execution Time': 1 },
    })),
  };
  const produced = await benchmark(
    manifest(),
    { ...process.env, PERTEXO_Q11_ISOLATED: '1' },
    {
      startDatabaseSampler: async () => ({
        beginScenario: async () => undefined,
        endScenario: async () => ({
          sqlRoundTrips: 1,
          serverExecutionMs: 1,
        }),
        stop: async () => observations,
      }),
      capturePostgresEvidence: async () => postgresEvidence,
      sourceIdentity: async () => ({
        workingTreeSha256: 'producer-source',
      }),
    },
  );
  assert.equal(validateBenchmarkEvidence(produced), produced);

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const corruptions = [
    (value) => delete value.scenarios[0].databaseWorkload,
    (value) => (value.scenarios[0].databaseWorkload.sqlRoundTrips = 0),
    (value) => delete value.scenarios[0].operationBreakdown['fixture-first'],
    (value) => (value.scenarios[0].launcherElapsedMs.mean += 1),
    (value) => value.scenarios[0].rounds.pop(),
    (value) => delete value.environment.cpuModel,
    (value) => (value.status = 'partial'),
  ];
  for (const corrupt of corruptions) {
    const invalid = clone(produced);
    corrupt(invalid);
    assert.throws(() => validateBenchmarkEvidence(invalid));
  }

  await t.test(
    'rejects corrupt producer evidence before output creation',
    async () => {
      const invalid = clone(produced);
      invalid.status = 'partial';
      let openAttempted = false;
      await assert.rejects(
        writeBenchmarkEvidence('must-not-exist.json', invalid, {
          open: async () => {
            openAttempted = true;
          },
        }),
      );
      assert.equal(openAttempted, false);
    },
  );

  for (const failureCase of [
    { name: 'write failure', writeFails: true, closeFails: false },
    { name: 'close failure', writeFails: false, closeFails: true },
    {
      name: 'combined write and close failure',
      writeFails: true,
      closeFails: true,
    },
  ])
    await t.test(failureCase.name, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-output-'));
      const outputFile = path.join(directory, 'evidence.json');
      const writeError = new Error('write failed');
      const closeError = new Error('close failed');
      let closeAttempted = false;
      try {
        const result = writeBenchmarkEvidence(outputFile, produced, {
          open: async (resolvedOutput, flag) => {
            assert.equal(flag, 'wx');
            await writeFile(resolvedOutput, 'incomplete', { flag });
            return {
              writeFile: async () => {
                if (failureCase.writeFails) throw writeError;
              },
              close: async () => {
                closeAttempted = true;
                if (failureCase.closeFails) throw closeError;
              },
            };
          },
        });
        if (failureCase.writeFails && failureCase.closeFails)
          await assert.rejects(result, (error) => {
            assert(error instanceof AggregateError);
            assert.deepEqual(error.errors, [writeError, closeError]);
            return true;
          });
        else
          await assert.rejects(
            result,
            failureCase.writeFails ? writeError : closeError,
          );
        assert.equal(closeAttempted, true);
        await assert.rejects(readFile(outputFile), { code: 'ENOENT' });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

  await t.test(
    'cleanup failure is retained after write and close failures',
    async () => {
      const failures = [
        new Error('write failed'),
        new Error('close failed'),
        new Error('cleanup failed'),
      ];
      await assert.rejects(
        writeBenchmarkEvidence('incomplete.json', produced, {
          open: async (_resolvedOutput, flag) => {
            assert.equal(flag, 'wx');
            return {
              writeFile: async () => {
                throw failures[0];
              },
              close: async () => {
                throw failures[1];
              },
            };
          },
          rm: async () => {
            throw failures[2];
          },
        }),
        (error) => {
          assert(error instanceof AggregateError);
          assert.deepEqual(error.errors, failures);
          return true;
        },
      );
    },
  );

  await t.test(
    'exclusive creation never removes a pre-existing output',
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-output-'));
      const outputFile = path.join(directory, 'evidence.json');
      let removeAttempted = false;
      try {
        await writeFile(outputFile, 'existing');
        await assert.rejects(
          writeBenchmarkEvidence(outputFile, produced, {
            rm: async () => {
              removeAttempted = true;
            },
          }),
          { code: 'EEXIST' },
        );
        assert.equal(removeAttempted, false);
        assert.equal(await readFile(outputFile, 'utf8'), 'existing');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test('releases declared contention participants together and proves overlap', async () => {
  const workload = `(async()=>{const {access,writeFile}=require('node:fs/promises');const path=require('node:path');const delay=require('node:timers/promises').setTimeout;const directory=process.env.PERTEXO_Q11_OVERLAP_DIRECTORY;const participant=process.env.PERTEXO_Q11_OVERLAP_PARTICIPANT;await writeFile(path.join(directory,participant+'.ready'),'',{flag:'wx'});for(;;){try{await access(path.join(directory,'release'));break}catch(error){if(error.code!=='ENOENT')throw error;await delay(5)}}const started=performance.timeOrigin+performance.now();await delay(80);const ended=performance.timeOrigin+performance.now();process.stdout.write('PERTEXO_Q11_OPERATION_V2='+JSON.stringify({schemaVersion:2,name:participant,startedAtUnixMs:started,endedAtUnixMs:ended,population:1,boundary:participant+' boundary',databaseIdentity:{database:'fixture',role:'fixture',applicationName:'q11-fixture-'+participant}})+'\\n')})()`;
  const base = manifest();
  const overlapManifest = manifest({
    scenarios: [
      {
        ...base.scenarios[0],
        requireOverlap: true,
        databaseScope: 'runner-owned-shared',
        fixturePopulation: { participants: 2 },
        commands: ['left', 'right'].map((participant) => ({
          participant,
          file: process.execPath,
          args: ['-e', workload],
          expectedOperations: [
            {
              name: participant,
              count: 1,
              population: 1,
              boundary: `${participant} boundary`,
              databaseScope: 'runner-owned-shared',
            },
          ],
        })),
      },
    ],
  });
  const unavailableSampler = async () => ({
    stop: async () => ({ available: false, reason: 'synthetic fixture' }),
  });
  const evidence = await benchmark(
    overlapManifest,
    {
      ...process.env,
      DATABASE_ADMIN_URL: '',
      DATABASE_MIGRATION_URL: '',
      PERTEXO_Q11_ISOLATED: '1',
    },
    {
      startDatabaseSampler: unavailableSampler,
      prepareScenarioDatabase: async (_scenario, environment) => ({
        databaseName: 'fixture',
        environment: {
          ...environment,
          PERTEXO_Q11_DATABASE_NAME: 'fixture',
          PERTEXO_Q11_SHARED_DATABASE_NAME: 'fixture',
        },
        close: async () => undefined,
      }),
    },
  );
  assert.equal(
    evidence.scenarios[0].rounds.every(
      ({ overlap }) => overlap.verified && overlap.overlapDurationMs > 0,
    ),
    true,
  );
});

test('samples a runner-owned fixture database separately from the configured base database', async () => {
  const base = manifest();
  const fixtureManifest = manifest({
    scenarios: [
      {
        ...base.scenarios[0],
        databaseScope: 'runner-owned-fixture',
      },
    ],
  });
  const sampledDatabases = [];
  let resetCount = 0;
  const observations = {
    available: true,
    sampleIntervalMs: 250,
    samples: [{ recordedAt: '2026-09-10T00:00:00.000Z' }],
  };
  const startDatabaseSampler = async (environment) => {
    const databaseName = environment.DATABASE_MIGRATION_URL
      ? new URL(environment.DATABASE_MIGRATION_URL).pathname.slice(1)
      : 'base';
    sampledDatabases.push(databaseName);
    return {
      beginScenario: async () => undefined,
      endScenario: async () =>
        databaseName === 'fixture'
          ? { sqlRoundTrips: 7, serverExecutionMs: 3.5 }
          : { sqlRoundTrips: 0, serverExecutionMs: 0 },
      stop: async () => observations,
    };
  };
  const evidence = await benchmark(
    fixtureManifest,
    {
      ...process.env,
      DATABASE_ADMIN_URL: '',
      DATABASE_MIGRATION_URL: '',
      PERTEXO_Q11_ISOLATED: '1',
    },
    {
      startDatabaseSampler,
      prepareScenarioDatabase: async (_scenario, environment) => ({
        databaseName: 'fixture',
        environment: {
          ...environment,
          DATABASE_MIGRATION_URL: 'postgres://migration@127.0.0.1/fixture',
          PERTEXO_Q11_DATABASE_NAME: 'fixture',
        },
        reset: async () => {
          resetCount += 1;
        },
        close: async () => undefined,
      }),
    },
  );

  assert.deepEqual(sampledDatabases, ['base', 'fixture']);
  assert.equal(resetCount, 4);
  assert.deepEqual(evidence.scenarios[0].databaseWorkload, {
    sqlRoundTrips: 0,
    serverExecutionMs: 0,
  });
  assert.deepEqual(evidence.scenarios[0].targetDatabase, {
    scope: 'runner-owned fixture database',
    databaseName: 'fixture',
    workload: { sqlRoundTrips: 7, serverExecutionMs: 3.5 },
    observations,
  });
});

test('fails closed when workloads omit declared operation measurements', async () => {
  const missing = manifest();
  missing.scenarios[0].commands[0].args = [
    '-e',
    "process.stdout.write('ok\\n')",
  ];
  await assert.rejects(
    () =>
      benchmark(missing, {
        ...process.env,
        DATABASE_ADMIN_URL: '',
        DATABASE_MIGRATION_URL: '',
        PERTEXO_Q11_ISOLATED: '1',
      }),
    /emitted 0 Q11 operation timings; expected 2/u,
  );
});

for (const terminationSignal of ['SIGINT', 'SIGTERM'])
  test(`interrupting the standalone benchmark with ${terminationSignal} terminates only its workload tree`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-benchmark-tree-'),
    );
    const manifestFile = path.join(directory, 'manifest.json');
    const outputFile = path.join(directory, 'evidence.json');
    const nestedPidFile = path.join(directory, 'nested.pid');
    const workload = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); writeFileSync(process.env.PERTEXO_TEST_NESTED_PID, String(child.pid)); setInterval(() => {}, 1000);`;
    await writeFile(
      manifestFile,
      `${JSON.stringify(
        manifest({
          scenarios: [
            {
              ...manifest().scenarios[0],
              commands: [
                {
                  file: process.execPath,
                  args: ['-e', workload],
                  expectedOperations: [
                    {
                      name: 'fixture',
                      count: 1,
                      population: 1,
                      boundary: 'fixture boundary',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      )}\n`,
    );
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    const runner = spawn(
      process.execPath,
      [
        'infrastructure/performance/run-local-benchmark.mjs',
        manifestFile,
        outputFile,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DATABASE_ADMIN_URL: '',
          DATABASE_MIGRATION_URL: '',
          PERTEXO_Q11_ISOLATED: '1',
          PERTEXO_TEST_NESTED_PID: nestedPidFile,
        },
        stdio: 'ignore',
      },
    );
    let nestedPid;
    try {
      nestedPid = Number(await waitForFile(nestedPidFile));
      runner.kill(terminationSignal);
      await once(runner, 'close');
      await delay(100);
      assert.equal(processExists(nestedPid), false);
      assert.equal(processExists(unrelated.pid), true);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null)
        runner.kill('SIGKILL');
      if (nestedPid && processExists(nestedPid))
        process.kill(nestedPid, 'SIGKILL');
      if (unrelated.pid && processExists(unrelated.pid))
        process.kill(-unrelated.pid, 'SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

test('a failed benchmark command cannot hang on output pipes inherited by a descendant', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-benchmark-failure-'),
  );
  const manifestFile = path.join(directory, 'manifest.json');
  const outputFile = path.join(directory, 'evidence.json');
  const nestedPidFile = path.join(directory, 'nested.pid');
  const workload = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); writeFileSync(process.env.PERTEXO_TEST_NESTED_PID, String(nested.pid)); process.exit(9);`;
  await writeFile(
    manifestFile,
    `${JSON.stringify(
      manifest({
        scenarios: [
          {
            ...manifest().scenarios[0],
            commands: [
              {
                file: process.execPath,
                args: ['-e', workload],
                expectedOperations: [
                  {
                    name: 'fixture',
                    count: 1,
                    population: 1,
                    boundary: 'fixture boundary',
                  },
                ],
              },
            ],
          },
        ],
      }),
    )}\n`,
  );
  const runner = spawn(
    process.execPath,
    [
      'infrastructure/performance/run-local-benchmark.mjs',
      manifestFile,
      outputFile,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_ADMIN_URL: '',
        DATABASE_MIGRATION_URL: '',
        PERTEXO_Q11_ISOLATED: '1',
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
        throw new Error('benchmark runner hung on inherited output pipes');
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

test('combined command and cleanup failure preserves both errors', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const execution = run('synthetic-command', [], {
    spawnOwned: () => {
      setImmediate(() => {
        child.emit('exit', 9, null);
      });
      return child;
    },
    releaseOwned: () => Promise.reject(new Error('termination failed')),
  }).then(
    () => ({ error: undefined }),
    (error) => ({ error }),
  );

  const result = await Promise.race([
    execution,
    delay(2_000, undefined, { ref: false }).then(() => ({
      error: new Error('combined failure did not settle'),
    })),
  ]);
  assert(result.error instanceof AggregateError);
  assert.deepEqual(
    result.error.errors.map((error) => error.message),
    ['synthetic-command failed (9)', 'termination failed'],
  );
});

test('benchmark command lifecycle reports spawn failure', async () => {
  await assert.rejects(
    run(`pertexo-command-that-does-not-exist-${String(process.pid)}`, []),
    { code: 'ENOENT' },
  );
});
