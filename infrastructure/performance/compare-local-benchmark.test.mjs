import assert from 'node:assert/strict';
import test from 'node:test';

import { compareEvidence } from './compare-local-benchmark.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

const summary = (value = 10) => ({
  minimum: value,
  p50: value,
  p95: value,
  p99: value,
  maximum: value,
  mean: value,
  standardDeviation: 0,
  coefficientOfVariation: 0,
});

const measuredSample = (overrides = {}) => ({
  name: 'operation',
  startedAtUnixMs: 100,
  endedAtUnixMs: 110,
  durationMs: 10,
  population: 1,
  boundary: 'call through commit',
  ...overrides,
});

function measuredRound(operationSamples, overrides = {}) {
  const startedAtUnixMs = Math.min(
    ...operationSamples.map((sample) => sample.startedAtUnixMs),
  );
  const endedAtUnixMs = Math.max(
    ...operationSamples.map((sample) => sample.endedAtUnixMs),
  );
  const durationMs = endedAtUnixMs - startedAtUnixMs;
  return {
    operationSamples,
    operationLatencyMs: operationSamples.map((sample) => sample.durationMs),
    workloadInterval: { startedAtUnixMs, endedAtUnixMs, durationMs },
    operationThroughputPerSecond:
      operationSamples.length / (durationMs / 1_000),
    launcherElapsedMs: 12,
    workloadProcessMetrics: {
      sampleIntervalMs: 100,
      samples: [
        { elapsedMs: 1, processCount: 1, rssBytes: 100, cpuPercent: 2 },
        { elapsedMs: 2, processCount: 2, rssBytes: 120, cpuPercent: 3 },
      ],
      peakRssBytes: 120,
      peakCpuPercent: 3,
      peakProcessCount: 2,
      rssTrendBytes: { first: 100, last: 120, delta: 20 },
    },
    ...overrides,
  };
}

function evidence(overrides = {}) {
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
  return {
    schemaVersion: 4,
    status: 'complete',
    recordedAt: '2026-09-10T10:00:00.000Z',
    manifestSha256: 'manifest',
    source: { workingTreeSha256: 'source-a' },
    environment: {
      node: 'v24',
      pnpm: '11',
      platform: 'darwin',
      release: '25',
      architecture: 'arm64',
      cpuModel: 'cpu',
      logicalCpuCount: 10,
      totalMemoryBytes: 24,
      seed: 1,
      warmupRounds: 1,
      measuredRounds: 5,
      serviceConfigurationSha256: 'services',
    },
    databaseObservations: observations,
    postgresEvidence: {
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
    },
    scenarios: [
      {
        name: 'fixture',
        configuration: {
          concurrency: 1,
          expectedOperationsPerRound: 1,
          databaseScope: 'configured-base',
          fixturePopulation: { operations: 1 },
          operationContracts: [
            {
              name: 'operation',
              count: 1,
              population: 1,
              boundary: 'call through commit',
            },
          ],
        },
        operationBreakdown: {
          operation: {
            latencyMs: summary(),
            throughputPerSecond: summary(100),
            populations: [1],
          },
        },
        operationThroughputPerSecond: summary(100),
        launcherElapsedMs: summary(12),
        workloadProcessPeakRssBytes: summary(120),
        workloadProcessPeakCpuPercent: summary(3),
        workloadProcessPeakCount: summary(2),
        workloadProcessRssDeltaBytes: summary(20),
        databaseWorkload: { sqlRoundTrips: 3, serverExecutionMs: 4 },
        rounds: Array.from({ length: 5 }, () =>
          measuredRound([measuredSample()]),
        ),
      },
    ],
    ...overrides,
  };
}

function sharedScenario() {
  const targetDatabaseName = 'pertexo_q11_fixture';
  const identity = (participant) => ({
    database: targetDatabaseName,
    role: `pertexo_${participant}`,
    applicationName: `q11-fixture-${participant}`,
  });
  return {
    ...evidence().scenarios[0],
    databaseWorkload: { sqlRoundTrips: 0, serverExecutionMs: 0 },
    operationBreakdown: {
      retention: {
        latencyMs: summary(),
        throughputPerSecond: summary(100),
        populations: [1],
      },
      foreground: {
        latencyMs: summary(),
        throughputPerSecond: summary(100),
        populations: [1],
      },
    },
    operationThroughputPerSecond: summary(2 / (11 / 1_000)),
    configuration: {
      ...evidence().scenarios[0].configuration,
      databaseScope: 'runner-owned-shared',
      requireOverlap: true,
      operationContracts: [
        {
          name: 'retention',
          count: 1,
          population: 1,
          boundary: 'retention boundary',
          participant: 'retention',
          databaseScope: 'runner-owned-shared',
        },
        {
          name: 'foreground',
          count: 1,
          population: 1,
          boundary: 'foreground boundary',
          participant: 'foreground',
          databaseScope: 'runner-owned-shared',
        },
      ],
      expectedOperationsPerRound: 2,
    },
    targetDatabase: {
      databaseName: targetDatabaseName,
      scope: 'runner-owned shared disposable database',
      workload: { sqlRoundTrips: 3, serverExecutionMs: 4 },
      observations: evidence().databaseObservations,
    },
    rounds: Array.from({ length: 5 }, () => {
      const samples = [
        measuredSample({
          name: 'retention',
          startedAtUnixMs: 100,
          endedAtUnixMs: 110,
          durationMs: 10,
          boundary: 'retention boundary',
          databaseIdentity: identity('maintenance'),
        }),
        measuredSample({
          name: 'foreground',
          startedAtUnixMs: 101,
          endedAtUnixMs: 111,
          durationMs: 10,
          boundary: 'foreground boundary',
          databaseIdentity: identity('api'),
        }),
      ];
      return measuredRound(samples, {
        overlap: {
          verified: true,
          overlapStartedAtUnixMs: 101,
          overlapEndedAtUnixMs: 110,
          overlapDurationMs: 9,
          intervals: [
            {
              participant: 'retention',
              startedAtUnixMs: 100,
              endedAtUnixMs: 110,
            },
            {
              participant: 'foreground',
              startedAtUnixMs: 101,
              endedAtUnixMs: 111,
            },
          ],
          databaseIdentities: samples.map(
            ({ databaseIdentity }) => databaseIdentity,
          ),
        },
      });
    }),
  };
}

function fixtureOwnedScenario() {
  const scenario = {
    ...evidence().scenarios[0],
    databaseWorkload: { sqlRoundTrips: 0, serverExecutionMs: 0 },
    configuration: {
      ...evidence().scenarios[0].configuration,
      databaseScope: 'runner-owned-fixture',
    },
    targetDatabase: {
      databaseName: 'pertexo_q11_fixture',
      scope: 'runner-owned fixture database',
      workload: { sqlRoundTrips: 3, serverExecutionMs: 4 },
      observations: evidence().databaseObservations,
    },
  };
  scenario.rounds = Array.from({ length: 5 }, () =>
    measuredRound([measuredSample()]),
  );
  return scenario;
}

test('compares operation variability, throughput, process, SQL and database evidence', () => {
  const baseline = evidence();
  const candidate = evidence({
    source: { workingTreeSha256: 'source-b' },
    scenarios: [
      {
        ...evidence().scenarios[0],
        operationBreakdown: {
          operation: {
            latencyMs: summary(8),
            throughputPerSecond: summary(125),
            populations: [1],
          },
        },
        operationThroughputPerSecond: summary(125),
        rounds: Array.from({ length: 5 }, () =>
          measuredRound([
            measuredSample({ endedAtUnixMs: 108, durationMs: 8 }),
          ]),
        ),
      },
    ],
  });
  const comparison = compareEvidence(baseline, candidate);
  assert.equal(comparison.sourceChanged, true);
  assert.equal(
    comparison.scenarios.fixture.operations.operation.latencyMs.mean.ratio,
    0.8,
  );
  assert.deepEqual(comparison.scenarios.fixture.sql.baseline, {
    sqlRoundTrips: 3,
    serverExecutionMs: 4,
  });
  assert.deepEqual(comparison.databaseObservations.baseline, {
    ...baseline.databaseObservations,
  });
  assert.deepEqual(comparison.scenarios.fixture.targetDatabaseObservations, {
    baseline: null,
    candidate: null,
  });
});

test('reports runner-owned target database observations per scenario', () => {
  const baselineScenario = fixtureOwnedScenario();
  const candidateScenario = fixtureOwnedScenario();
  candidateScenario.targetDatabase.observations.samples[0].databaseSizeBytes = 12;
  candidateScenario.targetDatabase.observations.databaseSizeBytes = summary(12);

  const comparison = compareEvidence(
    evidence({ scenarios: [baselineScenario] }),
    evidence({ scenarios: [candidateScenario] }),
  );

  assert.deepEqual(
    comparison.scenarios.fixture.targetDatabaseObservations.baseline,
    baselineScenario.targetDatabase.observations,
  );
  assert.deepEqual(
    comparison.scenarios.fixture.targetDatabaseObservations.candidate,
    candidateScenario.targetDatabase.observations,
  );
});

test('rejects incompatible operation contracts and fixture populations', () => {
  const candidate = evidence();
  candidate.scenarios[0].configuration.fixturePopulation.operations = 2;
  assert.throws(
    () => compareEvidence(evidence(), candidate),
    /contracts or fixtures/u,
  );
});

test('rejects missing markers and absent required measurements', () => {
  const missingMarker = evidence();
  missingMarker.scenarios[0].operationBreakdown = {};
  assert.throws(
    () => compareEvidence(evidence(), missingMarker),
    /markers are missing/u,
  );
  const missingMetric = evidence();
  missingMetric.scenarios[0].workloadProcessPeakRssBytes = null;
  assert.throws(
    () => compareEvidence(evidence(), missingMetric),
    /measurement is absent/u,
  );

  for (const [label, mutate] of [
    [
      'database observations',
      (candidate) => {
        candidate.databaseObservations = { available: false };
      },
    ],
    [
      'PostgreSQL evidence',
      (candidate) => {
        candidate.postgresEvidence = { available: false };
      },
    ],
    [
      'scenario SQL workload',
      (candidate) => {
        candidate.scenarios[0].databaseWorkload = null;
      },
    ],
    [
      'shared target evidence',
      (candidate) => {
        candidate.scenarios[0].configuration.databaseScope =
          'runner-owned-shared';
        candidate.scenarios[0].targetDatabase = null;
      },
    ],
  ]) {
    const candidate = evidence();
    mutate(candidate);
    assert.throws(
      () => compareEvidence(evidence(), candidate),
      /required .* (?:absent|missing|invalid)/u,
      label,
    );
  }
});

test('rejects missing aggregate operation markers on either or both sides', () => {
  for (const sides of [
    ['baseline'],
    ['candidate'],
    ['baseline', 'candidate'],
  ]) {
    const baseline = evidence();
    const candidate = evidence();
    for (const side of sides)
      (side === 'baseline'
        ? baseline
        : candidate
      ).scenarios[0].operationBreakdown = {};
    assert.throws(
      () => compareEvidence(baseline, candidate),
      /required operation markers are missing/u,
    );
  }

  const candidate = evidence();
  candidate.scenarios[0].operationBreakdown.operation.populations = [2];
  assert.throws(
    () => compareEvidence(evidence(), candidate),
    /declared populations are missing/u,
  );
});

test('rejects incomplete PostgreSQL evidence promised by the generator', () => {
  for (const mutate of [
    (candidate) => candidate.postgresEvidence.poolCheckoutWaitSeconds.pop(),
    (candidate) => {
      candidate.postgresEvidence.poolCheckoutWaitSeconds = [
        'bad',
        'bad',
        'bad',
      ];
    },
    (candidate) => {
      candidate.postgresEvidence.instrumentedSqlRoundTrips = -1;
    },
    (candidate) => candidate.postgresEvidence.queryPlans.pop(),
    (candidate) => {
      candidate.postgresEvidence.queryPlans[0].role = 'pertexo_api';
    },
    (candidate) => {
      candidate.postgresEvidence.queryPlans[0].plan = {};
    },
  ]) {
    const candidate = evidence();
    mutate(candidate);
    assert.throws(
      () => compareEvidence(evidence(), candidate),
      /required PostgreSQL evidence is invalid/u,
    );
  }
});

test('rejects invalid measured-round identities and overlap for a shared database', () => {
  const baseline = evidence({ scenarios: [sharedScenario()] });
  assert.doesNotThrow(() => compareEvidence(baseline, clone(baseline)));

  for (const mutate of [
    (scenario) => scenario.rounds.pop(),
    (scenario) => {
      scenario.rounds[0].operationSamples[0].databaseIdentity.database =
        'wrong_database';
    },
    (scenario) => {
      scenario.rounds[0].operationSamples[0].databaseIdentity.role = '';
    },
    (scenario) => {
      scenario.rounds[0].operationSamples[1].databaseIdentity.role =
        scenario.rounds[0].operationSamples[0].databaseIdentity.role;
    },
    (scenario) => {
      scenario.rounds[0].operationSamples[1].databaseIdentity.applicationName =
        scenario.rounds[0].operationSamples[0].databaseIdentity.applicationName;
    },
    (scenario) => {
      scenario.rounds[0].overlap.overlapDurationMs = 0;
    },
    (scenario) => {
      delete scenario.rounds[0].overlap.overlapStartedAtUnixMs;
    },
    (scenario) => {
      scenario.rounds[0].overlap.overlapEndedAtUnixMs = 109;
    },
    (scenario) => scenario.rounds[0].overlap.intervals.pop(),
    (scenario) => {
      scenario.rounds[0].overlap.intervals[0].startedAtUnixMs = 99;
    },
    (scenario) => scenario.rounds[0].overlap.databaseIdentities.pop(),
  ]) {
    const candidate = clone(baseline);
    mutate(candidate.scenarios[0]);
    assert.throws(
      () => compareEvidence(baseline, candidate),
      /rounds\[0\]|measured rounds are incomplete/u,
    );
  }
});

test('accepts zero base activity only when a runner-owned target has positive SQL evidence', () => {
  const fixtureOwned = evidence({ scenarios: [fixtureOwnedScenario()] });
  assert.doesNotThrow(() => compareEvidence(fixtureOwned, clone(fixtureOwned)));

  const missingTargetActivity = clone(fixtureOwned);
  missingTargetActivity.scenarios[0].targetDatabase.workload.sqlRoundTrips = 0;
  assert.throws(
    () => compareEvidence(fixtureOwned, missingTargetActivity),
    /targetDatabase\.sql required SQL measurement is absent/u,
  );

  const configuredBase = evidence();
  configuredBase.scenarios[0].databaseWorkload.sqlRoundTrips = 0;
  assert.throws(
    () => compareEvidence(configuredBase, evidence()),
    /fixture\.sql required SQL measurement is absent/u,
  );
});

test('rejects incomplete rounds and mislabeled runner-owned target scope', () => {
  for (const [label, baseline, mutate] of [
    ['configured-base rounds', evidence(), (scenario) => scenario.rounds.pop()],
    [
      'runner-owned fixture rounds',
      evidence({ scenarios: [fixtureOwnedScenario()] }),
      (scenario) => scenario.rounds.pop(),
    ],
    [
      'runner-owned fixture scope',
      evidence({ scenarios: [fixtureOwnedScenario()] }),
      (scenario) => {
        scenario.targetDatabase.scope = 'configured base database';
      },
    ],
    [
      'runner-owned shared scope',
      evidence({ scenarios: [sharedScenario()] }),
      (scenario) => {
        scenario.targetDatabase.scope = 'runner-owned fixture database';
      },
    ],
  ]) {
    const candidate = clone(baseline);
    mutate(candidate.scenarios[0]);
    assert.throws(
      () => compareEvidence(baseline, candidate),
      /measured rounds are incomplete|required shared target database evidence is absent/u,
      label,
    );
  }
});

test('rejects incomplete identities and benchmark environments on either side', () => {
  for (const side of ['baseline', 'candidate']) {
    for (const mutate of [
      (value) => {
        value.manifestSha256 = '';
      },
      (value) => {
        value.source.workingTreeSha256 = '';
      },
      (value) => {
        value.environment = { measuredRounds: 5 };
      },
      (value) => {
        value.environment.logicalCpuCount = 0;
      },
    ]) {
      const baseline = evidence();
      const candidate = evidence();
      mutate(side === 'baseline' ? baseline : candidate);
      assert.throws(
        () => compareEvidence(baseline, candidate),
        /identity is missing|fingerprint is missing|environment is incomplete/u,
      );
    }
  }
});

test('rejects missing and contract-inconsistent raw operation samples for every database scope', () => {
  for (const scenario of [evidence().scenarios[0], fixtureOwnedScenario()]) {
    const baseline = evidence({ scenarios: [scenario] });
    for (const mutate of [
      (sampleScenario) => {
        sampleScenario.rounds[0].operationSamples = [];
      },
      (sampleScenario) => {
        sampleScenario.rounds[0].operationSamples[0].population = 2;
      },
      (sampleScenario) => {
        sampleScenario.rounds[0].operationSamples[0].boundary = 'wrong';
      },
    ]) {
      const candidate = clone(baseline);
      mutate(candidate.scenarios[0]);
      assert.throws(
        () => compareEvidence(baseline, candidate),
        /rounds\[0\] operation samples/u,
      );
    }
  }
});

test('rejects missing or inconsistent raw operation timing and negative summaries', () => {
  for (const mutate of [
    (scenario) => {
      delete scenario.rounds[0].operationSamples[0].startedAtUnixMs;
    },
    (scenario) => {
      scenario.rounds[0].operationSamples[0].durationMs = 9;
    },
    (scenario) => {
      delete scenario.rounds[0].workloadInterval;
    },
    (scenario) => {
      scenario.rounds[0].operationLatencyMs = [];
    },
    (scenario) => {
      scenario.rounds[0].operationThroughputPerSecond = 0;
    },
    (scenario) => {
      scenario.workloadProcessPeakCpuPercent.minimum = -1;
    },
  ]) {
    const candidate = evidence();
    mutate(candidate.scenarios[0]);
    assert.throws(
      () => compareEvidence(evidence(), candidate),
      /operation timing is invalid|derived operation measurements are invalid|required measurement is absent/u,
    );
  }
});

test('rejects missing or inconsistent raw process and database observations', () => {
  for (const mutate of [
    (candidate) => {
      delete candidate.scenarios[0].rounds[0].launcherElapsedMs;
    },
    (candidate) => {
      candidate.scenarios[0].rounds[0].workloadProcessMetrics.samples = [];
    },
    (candidate) => {
      candidate.scenarios[0].rounds[0].workloadProcessMetrics.peakRssBytes = 0;
    },
    (candidate) => {
      delete candidate.databaseObservations.samples[0].connectionCount;
    },
    (candidate) => {
      candidate.scenarios[0].workloadProcessPeakCount = null;
    },
  ]) {
    const candidate = evidence();
    mutate(candidate);
    assert.throws(
      () => compareEvidence(evidence(), candidate),
      /process measurements are invalid|database observation sample is invalid|required measurement is absent/u,
    );
  }
});

test('rejects aggregate summaries that do not match retained raw measurements', () => {
  for (const mutate of [
    (scenario) => {
      scenario.operationBreakdown.operation.latencyMs.mean = 20;
      scenario.operationBreakdown.operation.latencyMs.maximum = 20;
    },
    (scenario) => {
      scenario.operationThroughputPerSecond.mean = 200;
      scenario.operationThroughputPerSecond.maximum = 200;
    },
    (scenario) => {
      scenario.workloadProcessPeakRssBytes.mean = 240;
      scenario.workloadProcessPeakRssBytes.maximum = 240;
    },
  ]) {
    const candidate = evidence();
    mutate(candidate.scenarios[0]);
    assert.throws(
      () => compareEvidence(evidence(), candidate),
      /does not match raw measurements/u,
    );
  }

  const candidate = evidence();
  candidate.databaseObservations.databaseSizeBytes.mean = 20;
  candidate.databaseObservations.databaseSizeBytes.maximum = 20;
  assert.throws(
    () => compareEvidence(evidence(), candidate),
    /does not match raw measurements/u,
  );
});

test('rejects duplicate scenario names on either side', () => {
  const duplicateBaseline = evidence();
  duplicateBaseline.scenarios.push({ ...duplicateBaseline.scenarios[0] });
  assert.throws(
    () => compareEvidence(duplicateBaseline, evidence()),
    /scenario names are missing or duplicated/u,
  );

  const duplicateCandidate = evidence();
  duplicateCandidate.scenarios.push({ ...duplicateCandidate.scenarios[0] });
  assert.throws(
    () => compareEvidence(evidence(), duplicateCandidate),
    /scenario names are missing or duplicated/u,
  );
});

test('rejects stale or partial evidence', () => {
  assert.throws(
    () => compareEvidence(evidence({ status: 'partial' }), evidence()),
    /stale or partial/u,
  );
});

test('rejects host, runtime, service and manifest mismatches but allows source changes', () => {
  assert.throws(
    () => compareEvidence(evidence(), evidence({ manifestSha256: 'other' })),
    /manifests or fixture populations/u,
  );
  const differentService = evidence();
  differentService.environment.serviceConfigurationSha256 = 'other';
  assert.throws(
    () => compareEvidence(evidence(), differentService),
    /service configuration/u,
  );
  assert.doesNotThrow(() =>
    compareEvidence(
      evidence(),
      evidence({ source: { workingTreeSha256: 'candidate' } }),
    ),
  );
});
