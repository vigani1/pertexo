import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { validatePostgresEvidence } from './postgres-evidence.mjs';

const summaryMetrics = Object.freeze([
  'minimum',
  'p50',
  'p95',
  'p99',
  'maximum',
  'mean',
  'standardDeviation',
  'coefficientOfVariation',
]);

function requireSummary(value, label, options = {}) {
  if (
    value === null ||
    typeof value !== 'object' ||
    summaryMetrics.some((metric) => !Number.isFinite(value[metric])) ||
    value.minimum > value.p50 ||
    value.p50 > value.p95 ||
    value.p95 > value.p99 ||
    value.p99 > value.maximum ||
    value.mean < value.minimum ||
    value.mean > value.maximum ||
    value.standardDeviation < 0 ||
    value.coefficientOfVariation < 0 ||
    (options.allowNegative !== true && value.minimum < 0)
  )
    throw new Error(`${label} required measurement is absent`);
  return value;
}

function approximatelyEqual(left, right) {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-12);
}

function summarizeValues(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    minimum: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    maximum: sorted.at(-1),
    mean,
    standardDeviation: Math.sqrt(variance),
    coefficientOfVariation:
      mean === 0 ? 0 : Math.sqrt(variance) / Math.abs(mean),
  };
}

function requireSummaryMatches(value, rawValues, label, options = {}) {
  requireSummary(value, label, options);
  if (
    !Array.isArray(rawValues) ||
    rawValues.length === 0 ||
    rawValues.some((rawValue) => !Number.isFinite(rawValue))
  )
    throw new Error(`${label} raw measurements are absent`);
  const expected = summarizeValues(rawValues);
  if (
    summaryMetrics.some(
      (metric) => !approximatelyEqual(value[metric], expected[metric]),
    )
  )
    throw new Error(`${label} does not match raw measurements`);
  return value;
}

function requireDatabaseWorkload(value, label, options = {}) {
  const minimumCalls = options.allowZero === true ? 0 : 1;
  if (
    value === null ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.sqlRoundTrips) ||
    value.sqlRoundTrips < minimumCalls ||
    !Number.isFinite(value.serverExecutionMs) ||
    value.serverExecutionMs < 0
  )
    throw new Error(`${label} required SQL measurement is absent`);
  return value;
}

function requireDatabaseObservations(value, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.available !== true ||
    !Number.isFinite(value.sampleIntervalMs) ||
    value.sampleIntervalMs <= 0 ||
    !Array.isArray(value.samples) ||
    value.samples.length === 0
  )
    throw new Error(`${label} required database observations are absent`);
  for (const sample of value.samples)
    if (
      !Number.isFinite(Date.parse(sample?.recordedAt)) ||
      [
        'databaseSizeBytes',
        'connectionCount',
        'activeTaskCount',
        'lockWaitCount',
      ].some(
        (metric) => !Number.isFinite(sample?.[metric]) || sample[metric] < 0,
      )
    )
      throw new Error(`${label} database observation sample is invalid`);
  for (const metric of [
    'databaseSizeBytes',
    'connectionCount',
    'activeTaskCount',
    'lockWaitCount',
  ])
    requireSummaryMatches(
      value[metric],
      value.samples.map((sample) => sample[metric]),
      `${label}.${metric}`,
    );
  return value;
}

function requirePostgresEvidence(value, label) {
  try {
    return validatePostgresEvidence(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${label} required PostgreSQL evidence is invalid: ${detail}`,
    );
  }
}

function scenarioMap(scenarios, label) {
  const result = new Map(
    scenarios.map((scenario) => [scenario.name, scenario]),
  );
  if (
    result.size !== scenarios.length ||
    scenarios.some(
      (scenario) =>
        typeof scenario.name !== 'string' || scenario.name.length === 0,
    )
  )
    throw new Error(`${label} scenario names are missing or duplicated`);
  return result;
}

function requireScenarioDatabaseEvidence(scenario, label) {
  const databaseScope = scenario.configuration?.databaseScope;
  if (
    !Number.isSafeInteger(scenario.environmentMeasuredRounds) ||
    scenario.environmentMeasuredRounds < 1 ||
    !Array.isArray(scenario.rounds) ||
    scenario.rounds.length !== scenario.environmentMeasuredRounds
  )
    throw new Error(`${label} measured rounds are incomplete`);
  const concurrency = scenario.configuration?.concurrency;
  const contracts = scenario.configuration?.operationContracts;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    !Array.isArray(contracts) ||
    contracts.length === 0 ||
    contracts.some(
      (contract) =>
        typeof contract?.name !== 'string' ||
        contract.name.length === 0 ||
        !Number.isSafeInteger(contract.count) ||
        contract.count < 1 ||
        !Number.isSafeInteger(contract.population) ||
        contract.population < 1 ||
        typeof contract.boundary !== 'string' ||
        contract.boundary.trim().length === 0,
    )
  )
    throw new Error(`${label} operation contracts are invalid`);
  const contractByName = new Map(
    contracts.map((contract) => [contract.name, contract]),
  );
  if (contractByName.size !== contracts.length)
    throw new Error(`${label} operation contracts are duplicated`);
  const breakdown = scenario.operationBreakdown;
  const breakdownNames = Object.keys(breakdown ?? {}).sort();
  const contractNames = [...contractByName.keys()].sort();
  if (
    breakdown === null ||
    typeof breakdown !== 'object' ||
    Array.isArray(breakdown) ||
    stable(breakdownNames) !== stable(contractNames)
  )
    throw new Error(`${label} required operation markers are missing`);
  for (const [name, contract] of contractByName) {
    const operation = breakdown[name];
    requireSummary(operation?.latencyMs, `${label}.${name}.latencyMs`);
    requireSummary(
      operation?.throughputPerSecond,
      `${label}.${name}.throughput`,
    );
    if (
      !Array.isArray(operation?.populations) ||
      stable(operation.populations) !== stable([contract.population])
    )
      throw new Error(`${label}.${name} declared populations are missing`);
  }
  const expectedOperationsPerRound =
    concurrency * contracts.reduce((sum, contract) => sum + contract.count, 0);
  if (
    scenario.configuration.expectedOperationsPerRound !==
    expectedOperationsPerRound
  )
    throw new Error(`${label} expected operation count is invalid`);
  for (const [roundIndex, round] of scenario.rounds.entries()) {
    if (
      !Array.isArray(round.operationSamples) ||
      round.operationSamples.length !== expectedOperationsPerRound
    )
      throw new Error(
        `${label}.rounds[${roundIndex}] operation samples are absent or incomplete`,
      );
    for (const sample of round.operationSamples)
      if (
        !Number.isFinite(sample?.startedAtUnixMs) ||
        !Number.isFinite(sample?.endedAtUnixMs) ||
        sample.endedAtUnixMs <= sample.startedAtUnixMs ||
        !Number.isFinite(sample?.durationMs) ||
        sample.durationMs <= 0 ||
        !approximatelyEqual(
          sample.durationMs,
          sample.endedAtUnixMs - sample.startedAtUnixMs,
        )
      )
        throw new Error(
          `${label}.rounds[${roundIndex}] operation timing is invalid`,
        );
    for (const contract of contracts) {
      const matching = round.operationSamples.filter(
        (sample) => sample?.name === contract.name,
      );
      if (
        matching.length !== concurrency * contract.count ||
        matching.some(
          (sample) =>
            sample.population !== contract.population ||
            sample.boundary !== contract.boundary,
        )
      )
        throw new Error(
          `${label}.rounds[${roundIndex}] operation samples violate their contract`,
        );
    }
    if (
      round.operationSamples.some((sample) => !contractByName.has(sample?.name))
    )
      throw new Error(
        `${label}.rounds[${roundIndex}] undeclared operation sample is present`,
      );
    const workloadStartedAtUnixMs = Math.min(
      ...round.operationSamples.map((sample) => sample.startedAtUnixMs),
    );
    const workloadEndedAtUnixMs = Math.max(
      ...round.operationSamples.map((sample) => sample.endedAtUnixMs),
    );
    const workloadDurationMs = workloadEndedAtUnixMs - workloadStartedAtUnixMs;
    if (
      round.workloadInterval?.startedAtUnixMs !== workloadStartedAtUnixMs ||
      round.workloadInterval?.endedAtUnixMs !== workloadEndedAtUnixMs ||
      !approximatelyEqual(
        round.workloadInterval?.durationMs,
        workloadDurationMs,
      ) ||
      !Array.isArray(round.operationLatencyMs) ||
      round.operationLatencyMs.length !== round.operationSamples.length ||
      round.operationLatencyMs.some(
        (duration, index) =>
          !Number.isFinite(duration) ||
          duration <= 0 ||
          !approximatelyEqual(
            duration,
            round.operationSamples[index].durationMs,
          ),
      ) ||
      !Number.isFinite(round.operationThroughputPerSecond) ||
      round.operationThroughputPerSecond <= 0 ||
      !approximatelyEqual(
        round.operationThroughputPerSecond,
        round.operationSamples.length / (workloadDurationMs / 1_000),
      )
    )
      throw new Error(
        `${label}.rounds[${roundIndex}] derived operation measurements are invalid`,
      );
    const processMetrics = round.workloadProcessMetrics;
    if (
      !Number.isFinite(round.launcherElapsedMs) ||
      round.launcherElapsedMs <= 0 ||
      !Number.isFinite(processMetrics?.sampleIntervalMs) ||
      processMetrics.sampleIntervalMs <= 0 ||
      !Array.isArray(processMetrics.samples) ||
      processMetrics.samples.length === 0 ||
      processMetrics.samples.some(
        (sample) =>
          !Number.isFinite(sample?.elapsedMs) ||
          sample.elapsedMs < 0 ||
          !Number.isSafeInteger(sample?.processCount) ||
          sample.processCount < 0 ||
          !Number.isFinite(sample?.rssBytes) ||
          sample.rssBytes < 0 ||
          !Number.isFinite(sample?.cpuPercent) ||
          sample.cpuPercent < 0,
      )
    )
      throw new Error(
        `${label}.rounds[${roundIndex}] process measurements are invalid`,
      );
    const rssValues = processMetrics.samples.map((sample) => sample.rssBytes);
    const cpuValues = processMetrics.samples.map((sample) => sample.cpuPercent);
    const processCounts = processMetrics.samples.map(
      (sample) => sample.processCount,
    );
    if (
      processMetrics.peakRssBytes !== Math.max(...rssValues) ||
      processMetrics.peakCpuPercent !== Math.max(...cpuValues) ||
      processMetrics.peakProcessCount !== Math.max(...processCounts) ||
      processMetrics.rssTrendBytes?.first !== rssValues[0] ||
      processMetrics.rssTrendBytes?.last !== rssValues.at(-1) ||
      processMetrics.rssTrendBytes?.delta !== rssValues.at(-1) - rssValues[0]
    )
      throw new Error(
        `${label}.rounds[${roundIndex}] derived process measurements are invalid`,
      );
  }
  for (const [name] of contractByName) {
    const samplesByRound = scenario.rounds.map((round) =>
      round.operationSamples.filter((sample) => sample.name === name),
    );
    requireSummaryMatches(
      breakdown[name].latencyMs,
      samplesByRound.flatMap((samples) =>
        samples.map((sample) => sample.durationMs),
      ),
      `${label}.${name}.latencyMs`,
    );
    requireSummaryMatches(
      breakdown[name].throughputPerSecond,
      samplesByRound.map((samples) => {
        const startedAt = Math.min(
          ...samples.map((sample) => sample.startedAtUnixMs),
        );
        const endedAt = Math.max(
          ...samples.map((sample) => sample.endedAtUnixMs),
        );
        return samples.length / ((endedAt - startedAt) / 1_000);
      }),
      `${label}.${name}.throughput`,
    );
  }
  if (databaseScope === 'configured-base') {
    requireDatabaseWorkload(scenario.databaseWorkload, `${label}.sql`);
    if (
      scenario.targetDatabase !== null &&
      scenario.targetDatabase !== undefined
    )
      throw new Error(
        `${label} unexpected target database evidence is present`,
      );
    return;
  }
  if (
    databaseScope !== 'runner-owned-fixture' &&
    databaseScope !== 'runner-owned-shared'
  )
    throw new Error(`${label} database scope is invalid`);
  requireDatabaseWorkload(scenario.databaseWorkload, `${label}.baseSql`, {
    allowZero: true,
  });
  const target = scenario.targetDatabase;
  if (
    target === null ||
    typeof target !== 'object' ||
    typeof target.databaseName !== 'string' ||
    target.databaseName.length === 0 ||
    target.scope !==
      (databaseScope === 'runner-owned-fixture'
        ? 'runner-owned fixture database'
        : 'runner-owned shared disposable database')
  )
    throw new Error(
      `${label} required shared target database evidence is absent`,
    );
  requireDatabaseWorkload(target.workload, `${label}.targetDatabase.sql`);
  requireDatabaseObservations(
    target.observations,
    `${label}.targetDatabase.observations`,
  );

  if (databaseScope === 'runner-owned-fixture') return;

  for (const [roundIndex, round] of scenario.rounds.entries()) {
    const participantIdentities = new Map();
    const samplesByParticipant = new Map(
      contracts.map((contract) => [contract.participant, []]),
    );
    for (const sample of round.operationSamples) {
      const contract = contractByName.get(sample.name);
      const identity = sample.databaseIdentity;
      if (
        contract?.databaseScope !== 'runner-owned-shared' ||
        typeof contract.participant !== 'string' ||
        contract.participant.length === 0 ||
        identity === null ||
        typeof identity !== 'object' ||
        identity.database !== target.databaseName ||
        typeof identity.role !== 'string' ||
        identity.role.length === 0 ||
        typeof identity.applicationName !== 'string' ||
        identity.applicationName.length === 0
      )
        throw new Error(
          `${label}.rounds[${roundIndex}] shared-database identity is invalid`,
        );
      const signature = `${identity.role}\u0000${identity.applicationName}`;
      const prior = participantIdentities.get(contract.participant);
      if (prior !== undefined && prior !== signature)
        throw new Error(
          `${label}.rounds[${roundIndex}] participant identity is inconsistent`,
        );
      participantIdentities.set(contract.participant, signature);
      samplesByParticipant.get(contract.participant).push(sample);
    }
    const expectedParticipants = new Set(
      contracts.map((contract) => contract.participant),
    );
    const identities = [...participantIdentities.values()].map((signature) => {
      const [role, applicationName] = signature.split('\u0000');
      return { role, applicationName };
    });
    if (
      participantIdentities.size !== expectedParticipants.size ||
      [...expectedParticipants].some(
        (participant) => !participantIdentities.has(participant),
      ) ||
      new Set(identities.map(({ role }) => role)).size !== identities.length ||
      new Set(identities.map(({ applicationName }) => applicationName)).size !==
        identities.length
    )
      throw new Error(
        `${label}.rounds[${roundIndex}] participant identities are missing or duplicated`,
      );

    if (scenario.configuration.requireOverlap === true) {
      const expectedIntervals = [...samplesByParticipant].map(
        ([participant, samples]) => ({
          participant,
          startedAtUnixMs: Math.min(
            ...samples.map(({ startedAtUnixMs }) => startedAtUnixMs),
          ),
          endedAtUnixMs: Math.max(
            ...samples.map(({ endedAtUnixMs }) => endedAtUnixMs),
          ),
        }),
      );
      const overlapStartedAtUnixMs = Math.max(
        ...expectedIntervals.map(({ startedAtUnixMs }) => startedAtUnixMs),
      );
      const overlapEndedAtUnixMs = Math.min(
        ...expectedIntervals.map(({ endedAtUnixMs }) => endedAtUnixMs),
      );
      if (
        round.overlap?.verified !== true ||
        stable(round.overlap.intervals) !== stable(expectedIntervals) ||
        round.overlap.overlapStartedAtUnixMs !== overlapStartedAtUnixMs ||
        round.overlap.overlapEndedAtUnixMs !== overlapEndedAtUnixMs ||
        overlapEndedAtUnixMs <= overlapStartedAtUnixMs ||
        !approximatelyEqual(
          round.overlap.overlapDurationMs,
          overlapEndedAtUnixMs - overlapStartedAtUnixMs,
        )
      )
        throw new Error(
          `${label}.rounds[${roundIndex}] required temporal overlap is absent`,
        );
      const overlapIdentities = round.overlap.databaseIdentities;
      const overlapSignatures = new Set(
        overlapIdentities?.map(
          (identity) => `${identity?.role}\u0000${identity?.applicationName}`,
        ),
      );
      if (
        !Array.isArray(overlapIdentities) ||
        overlapIdentities.length !== participantIdentities.size ||
        overlapIdentities.some(
          (identity) => identity?.database !== target.databaseName,
        ) ||
        [...participantIdentities.values()].some(
          (signature) => !overlapSignatures.has(signature),
        )
      )
        throw new Error(
          `${label}.rounds[${roundIndex}] overlap identities are invalid`,
        );
    }
  }
}

function ratio(candidate, baseline) {
  return baseline === 0 ? null : candidate / baseline;
}

function compareSummary(baseline, candidate, label, options = {}) {
  const before = requireSummary(baseline, `baseline ${label}`, options);
  const after = requireSummary(candidate, `candidate ${label}`, options);
  return Object.fromEntries(
    summaryMetrics.map((metric) => [
      metric,
      {
        baseline: before[metric],
        candidate: after[metric],
        ratio: ratio(after[metric], before[metric]),
        delta: after[metric] - before[metric],
      },
    ]),
  );
}

function assertEvidence(evidence, label) {
  if (evidence?.schemaVersion !== 4)
    throw new Error(`${label} uses an incompatible evidence schema`);
  if (evidence.status !== 'complete')
    throw new Error(`${label} evidence is stale or partial`);
  if (!Number.isFinite(Date.parse(evidence.recordedAt)))
    throw new Error(`${label} recordedAt is invalid`);
  if (!Array.isArray(evidence.scenarios) || evidence.scenarios.length === 0)
    throw new Error(`${label} scenarios are missing`);
  if (
    typeof evidence.manifestSha256 !== 'string' ||
    evidence.manifestSha256.length === 0
  )
    throw new Error(`${label} manifest identity is missing`);
  if (
    typeof evidence.source?.workingTreeSha256 !== 'string' ||
    evidence.source.workingTreeSha256.length === 0
  )
    throw new Error(`${label} source fingerprint is missing`);
  const stringEnvironmentKeys = [
    'node',
    'pnpm',
    'platform',
    'release',
    'architecture',
    'cpuModel',
    'serviceConfigurationSha256',
  ];
  if (
    stringEnvironmentKeys.some(
      (key) =>
        typeof evidence.environment?.[key] !== 'string' ||
        evidence.environment[key].length === 0,
    ) ||
    !Number.isSafeInteger(evidence.environment?.logicalCpuCount) ||
    evidence.environment.logicalCpuCount < 1 ||
    !Number.isSafeInteger(evidence.environment?.totalMemoryBytes) ||
    evidence.environment.totalMemoryBytes < 1 ||
    !Number.isSafeInteger(evidence.environment?.seed) ||
    !Number.isSafeInteger(evidence.environment?.warmupRounds) ||
    evidence.environment.warmupRounds < 1 ||
    !Number.isSafeInteger(evidence.environment?.measuredRounds) ||
    evidence.environment.measuredRounds < 1
  )
    throw new Error(`${label} benchmark environment is incomplete`);
  scenarioMap(evidence.scenarios, label);
  requireDatabaseObservations(
    evidence.databaseObservations,
    `${label}.databaseObservations`,
  );
  requirePostgresEvidence(
    evidence.postgresEvidence,
    `${label}.postgresEvidence`,
  );
  for (const scenario of evidence.scenarios) {
    requireScenarioDatabaseEvidence(
      {
        ...scenario,
        environmentMeasuredRounds: evidence.environment?.measuredRounds,
      },
      `${label}.${scenario.name}`,
    );
    requireSummaryMatches(
      scenario.launcherElapsedMs,
      scenario.rounds.map((round) => round.launcherElapsedMs),
      `${label}.${scenario.name}.launcherElapsedMs`,
    );
    requireSummaryMatches(
      scenario.operationThroughputPerSecond,
      scenario.rounds.map((round) => round.operationThroughputPerSecond),
      `${label}.${scenario.name}.throughput`,
    );
    requireSummaryMatches(
      scenario.workloadProcessPeakRssBytes,
      scenario.rounds.map((round) => round.workloadProcessMetrics.peakRssBytes),
      `${label}.${scenario.name}.peakRssBytes`,
    );
    requireSummaryMatches(
      scenario.workloadProcessPeakCpuPercent,
      scenario.rounds.map(
        (round) => round.workloadProcessMetrics.peakCpuPercent,
      ),
      `${label}.${scenario.name}.peakCpuPercent`,
    );
    requireSummaryMatches(
      scenario.workloadProcessPeakCount,
      scenario.rounds.map(
        (round) => round.workloadProcessMetrics.peakProcessCount,
      ),
      `${label}.${scenario.name}.peakProcessCount`,
    );
    requireSummaryMatches(
      scenario.workloadProcessRssDeltaBytes,
      scenario.rounds.map(
        (round) => round.workloadProcessMetrics.rssTrendBytes.delta,
      ),
      `${label}.${scenario.name}.rssDeltaBytes`,
      { allowNegative: true },
    );
  }
}

export function validateBenchmarkEvidence(evidence, label = 'Benchmark') {
  assertEvidence(evidence, label);
  return evidence;
}

function stable(value) {
  const canonical = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate !== null && typeof candidate === 'object')
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map((key) => [key, canonical(candidate[key])]),
      );
    return candidate;
  };
  return JSON.stringify(canonical(value));
}

export function compareEvidence(baseline, candidate) {
  validateBenchmarkEvidence(baseline, 'Baseline');
  validateBenchmarkEvidence(candidate, 'Candidate');
  if (baseline.manifestSha256 !== candidate.manifestSha256)
    throw new Error(
      'Benchmark manifests or fixture populations are incompatible',
    );
  const environmentKeys = [
    'node',
    'pnpm',
    'platform',
    'release',
    'architecture',
    'cpuModel',
    'logicalCpuCount',
    'totalMemoryBytes',
    'seed',
    'warmupRounds',
    'measuredRounds',
    'serviceConfigurationSha256',
  ];
  for (const key of environmentKeys)
    if (baseline.environment?.[key] !== candidate.environment?.[key])
      throw new Error(
        `Host, runtime, or service configuration differs at ${key}`,
      );
  const candidateByName = scenarioMap(candidate.scenarios, 'Candidate');
  if (candidateByName.size !== baseline.scenarios.length)
    throw new Error('Candidate scenarios are missing or extra');
  const scenarios = {};
  for (const before of baseline.scenarios) {
    const after = candidateByName.get(before.name);
    if (after === undefined)
      throw new Error(`${before.name}: candidate scenario is missing`);
    if (stable(before.configuration) !== stable(after.configuration))
      throw new Error(
        `${before.name}: operation contracts or fixtures are incompatible`,
      );
    const beforeOperations = Object.keys(
      before.operationBreakdown ?? {},
    ).sort();
    const afterOperations = Object.keys(after.operationBreakdown ?? {}).sort();
    if (stable(beforeOperations) !== stable(afterOperations))
      throw new Error(`${before.name}: required operation markers are missing`);
    scenarios[before.name] = {
      operations: Object.fromEntries(
        beforeOperations.map((name) => [
          name,
          {
            latencyMs: compareSummary(
              before.operationBreakdown[name]?.latencyMs,
              after.operationBreakdown[name]?.latencyMs,
              `${before.name}.${name}.latencyMs`,
            ),
            throughputPerSecond: compareSummary(
              before.operationBreakdown[name]?.throughputPerSecond,
              after.operationBreakdown[name]?.throughputPerSecond,
              `${before.name}.${name}.throughput`,
            ),
          },
        ]),
      ),
      throughputPerSecond: compareSummary(
        before.operationThroughputPerSecond,
        after.operationThroughputPerSecond,
        `${before.name}.throughput`,
      ),
      process: {
        launcherElapsedMs: compareSummary(
          before.launcherElapsedMs,
          after.launcherElapsedMs,
          `${before.name}.launcherElapsedMs`,
        ),
        peakRssBytes: compareSummary(
          before.workloadProcessPeakRssBytes,
          after.workloadProcessPeakRssBytes,
          `${before.name}.peakRssBytes`,
        ),
        peakCpuPercent: compareSummary(
          before.workloadProcessPeakCpuPercent,
          after.workloadProcessPeakCpuPercent,
          `${before.name}.peakCpuPercent`,
        ),
        peakProcessCount: compareSummary(
          before.workloadProcessPeakCount,
          after.workloadProcessPeakCount,
          `${before.name}.peakProcessCount`,
        ),
        rssDeltaBytes: compareSummary(
          before.workloadProcessRssDeltaBytes,
          after.workloadProcessRssDeltaBytes,
          `${before.name}.rssDeltaBytes`,
          { allowNegative: true },
        ),
      },
      sql: {
        baseline: before.databaseWorkload ?? null,
        candidate: after.databaseWorkload ?? null,
        targetDatabaseBaseline: before.targetDatabase?.workload ?? null,
        targetDatabaseCandidate: after.targetDatabase?.workload ?? null,
      },
      targetDatabaseObservations: {
        baseline: before.targetDatabase?.observations ?? null,
        candidate: after.targetDatabase?.observations ?? null,
      },
    };
  }
  return {
    schemaVersion: 1,
    baseline: {
      recordedAt: baseline.recordedAt,
      source: baseline.source.workingTreeSha256,
    },
    candidate: {
      recordedAt: candidate.recordedAt,
      source: candidate.source.workingTreeSha256,
    },
    sourceChanged:
      baseline.source.workingTreeSha256 !== candidate.source.workingTreeSha256,
    scenarios,
    databaseObservations: {
      baseline: baseline.databaseObservations,
      candidate: candidate.databaseObservations,
    },
    postgresEvidence: {
      baseline: baseline.postgresEvidence,
      candidate: candidate.postgresEvidence,
    },
  };
}

async function main() {
  const [baselineFile, candidateFile] = process.argv.slice(2);
  if (!baselineFile || !candidateFile)
    throw new Error(
      'Usage: compare-local-benchmark.mjs <baseline> <candidate>',
    );
  const [baseline, candidate] = await Promise.all(
    [baselineFile, candidateFile].map(async (file) =>
      JSON.parse(await readFile(path.resolve(file), 'utf8')),
    ),
  );
  process.stdout.write(
    `${JSON.stringify(compareEvidence(baseline, candidate), null, 2)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
