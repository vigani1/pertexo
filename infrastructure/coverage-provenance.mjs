import { createHash } from 'node:crypto';
import process from 'node:process';

import ts from 'typescript';

import { validateVitestGateReport } from './validate-vitest-gate-report.mjs';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function coverageSourceFingerprint(sources) {
  const digest = createHash('sha256');
  for (const [file, source] of [...sources.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    digest.update(file);
    digest.update('\0');
    digest.update(source);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

export function createCoverageSourceWitness({
  capturedAt = Date.now(),
  sources,
}) {
  if (!Number.isFinite(capturedAt) || capturedAt < 0)
    throw new Error('Coverage source witness timestamp is invalid');
  return {
    schemaVersion: 1,
    command: 'pnpm test:coverage',
    capturedAt,
    sourceFingerprint: coverageSourceFingerprint(sources),
    sourceFiles: [...sources.keys()].sort(),
  };
}

function validatedSourceWitness(witness, sources, cohorts) {
  const expected = createCoverageSourceWitness({
    capturedAt: witness?.capturedAt,
    sources,
  });
  if (
    witness?.schemaVersion !== 1 ||
    witness.command !== 'pnpm test:coverage' ||
    JSON.stringify(witness) !== JSON.stringify(expected)
  )
    throw new Error('Coverage source witness does not match current source');
  const stale = cohorts.find(
    ({ resultStartTime }) => resultStartTime < witness.capturedAt,
  );
  if (stale !== undefined)
    throw new Error(
      `Coverage result for ${stale.cohort} was produced before the source witness`,
    );
  return expected;
}

function validatedArtifactRecords(artifacts) {
  return [...artifacts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cohort, artifact]) => {
      validateVitestGateReport(
        artifact.result,
        `${cohort} coverage producer`,
        1,
        0,
      );
      if (
        !Number.isFinite(artifact.result.startTime) ||
        !Array.isArray(artifact.result.testResults) ||
        artifact.result.testResults.length === 0 ||
        artifact.result.testResults.some(
          (suite) =>
            !Number.isFinite(suite?.endTime) ||
            suite.endTime < artifact.result.startTime ||
            !Array.isArray(suite?.assertionResults),
        )
      )
        throw new Error(`Malformed ${cohort} coverage producer result`);
      return {
        cohort,
        coverageSha256: sha256(artifact.coverageBytes),
        resultSha256: sha256(artifact.resultBytes),
        resultStartTime: artifact.result.startTime,
        resultCompletedAt: Math.max(
          artifact.result.startTime,
          ...artifact.result.testResults.map(({ endTime }) => endTime),
        ),
      };
    });
}

export function createCoverageProducerManifest({
  artifacts,
  generatedAt = new Date().toISOString(),
  packageManager,
  riskReport,
  riskReportBytes,
  sourceWitness,
  sources,
}) {
  const cohorts = validatedArtifactRecords(artifacts);
  const validatedWitness = validatedSourceWitness(
    sourceWitness,
    sources,
    cohorts,
  );
  const generatedAtMillis = Date.parse(generatedAt);
  if (
    !Number.isFinite(generatedAtMillis) ||
    cohorts.some(
      ({ resultStartTime, resultCompletedAt }) =>
        !Number.isFinite(resultStartTime) ||
        !Number.isFinite(resultCompletedAt) ||
        resultCompletedAt < resultStartTime ||
        resultCompletedAt > generatedAtMillis,
    )
  )
    throw new Error('Coverage producer interval is invalid');
  if (validatedWitness.capturedAt > generatedAtMillis)
    throw new Error('Coverage producer interval is invalid');
  if (!/^sha256:[\da-f]{64}$/u.test(riskReport?.sourceRevision ?? ''))
    throw new Error('Coverage risk source revision is missing');
  return {
    schemaVersion: 2,
    command: 'pnpm test:coverage',
    generatedAt,
    candidateFingerprint: coverageSourceFingerprint(sources),
    sourceWitness: validatedWitness,
    runtime: {
      node: process.version,
      packageManager,
      typescript: ts.version,
    },
    cohorts,
    riskReport: {
      sha256: sha256(riskReportBytes),
      sourceRevision: riskReport.sourceRevision,
    },
  };
}

export function validateCoverageProducerManifest(input) {
  const expected = createCoverageProducerManifest({
    ...input,
    generatedAt: input.manifest?.generatedAt,
  });
  if (
    input.manifest?.schemaVersion !== 2 ||
    input.manifest.command !== 'pnpm test:coverage' ||
    JSON.stringify(input.manifest) !== JSON.stringify(expected)
  )
    throw new Error(
      'Coverage producer manifest does not match current source and artifacts',
    );
  return input.manifest;
}
