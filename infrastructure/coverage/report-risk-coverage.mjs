#!/usr/bin/env node

import console from 'node:console';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateVitestGateReport } from './validate-vitest-gate-report.mjs';

const REVIEW_CLASSIFICATIONS = new Set([
  'defensive',
  'unreachable',
  'generated',
  'integration',
]);

export const RISK_COVERAGE_COHORTS = [
  'artifact-store',
  'contracts',
  'integrations',
  'workflow-engine',
  'database',
  'worker',
  'api',
  'api-priority',
  'api-orchestration',
  'lifecycle-command',
  'api-entrypoints',
  'worker-entrypoints',
  'operator-command-entrypoints',
  'recovery-entrypoints',
  'retention-entrypoints',
];

const EXHAUSTIVE_RISK_COHORT_DIRECTORIES = Object.freeze({
  'artifact-store': 'packages/artifact-store/src',
  contracts: 'packages/contracts/src',
  integrations: 'packages/integrations/src',
});

const EXACT_RISK_COHORT_FILES = Object.freeze({
  api: [
    'apps/api/src/identity/crypto.ts',
    'apps/api/src/identity/csrf.ts',
    'apps/api/src/identity/session.ts',
    'apps/api/src/platform/http/application-error.ts',
    'apps/api/src/platform/http/problem-details.filter.ts',
    'apps/api/src/platform/http/request-headers.ts',
    'apps/api/src/platform/rate-limit/interceptor.ts',
    'apps/api/src/platform/rate-limit/metadata.ts',
    'apps/api/src/platform/rate-limit/metrics.ts',
    'apps/api/src/platform/rate-limit/rate-limit.module.ts',
    'apps/api/src/workspaces/authorize-workspace.ts',
    'apps/api/src/workspaces/policy.ts',
  ],
  'api-entrypoints': ['apps/api/src/main.ts'],
  'api-orchestration': [
    'apps/api/src/application-error-mappers.ts',
    'apps/api/src/connections/connection-testing.ts',
    'apps/api/src/workflow-runs/sse-authorization-lifetime.ts',
    'apps/api/src/workflow-runs/statistics-use-case.ts',
    'apps/api/src/workflow-runs/use-cases.ts',
  ],
  'api-priority': [
    'apps/api/src/app.ts',
    'apps/api/src/identity/oidc.ts',
    'apps/api/src/identity-infrastructure/oidc-adapter.ts',
    'apps/api/src/identity-infrastructure/oidc-request-validation.ts',
    'apps/api/src/identity-infrastructure/oidc-response-cleanup.ts',
    'apps/api/src/identity-infrastructure/oidc-secret-encryption.ts',
    'apps/api/src/identity-workspace/module.ts',
    'apps/api/src/identity-workspace/persistence-capabilities.ts',
    'apps/api/src/identity-workspace/use-cases.ts',
    'apps/api/src/platform/identity/better-auth-composition.ts',
    'apps/api/src/platform/identity/identity-runtime.module.ts',
    'apps/api/src/platform/identity/oidc-runtime.ts',
    'apps/api/src/webhooks/ingress.ts',
    'apps/api/src/workflow-authoring/lifecycle-use-case.ts',
    'apps/api/src/workflow-authoring/module.ts',
    'apps/api/src/workflow-authoring/preconditions.ts',
    'apps/api/src/workflow-authoring/restore-version-use-case.ts',
    'apps/api/src/workflow-authoring/use-cases.ts',
  ],
  database: [
    'packages/database/src/tenant-access/workspace-policy.ts',
    'packages/database/src/tenant-access/workspace.ts',
  ],
  'lifecycle-command': [
    'apps/lifecycle-command/src/config.ts',
    'apps/lifecycle-command/src/main.ts',
    'apps/lifecycle-command/src/readiness-marker.ts',
    'apps/lifecycle-command/src/run.ts',
  ],
  'operator-command-entrypoints': ['apps/operator-command/src/main.ts'],
  'recovery-entrypoints': ['apps/recovery/src/main.ts'],
  'retention-entrypoints': ['apps/retention/src/main.ts'],
  worker: [
    'apps/worker/src/execution/failure-notification-delivery.ts',
    'apps/worker/src/execution/node-artifact-policy.ts',
    'apps/worker/src/execution/node-attempt-execution-environment.ts',
    'apps/worker/src/execution/node-attempt-handler-state-error.ts',
    'apps/worker/src/execution/node-attempt-handler.ts',
    'apps/worker/src/execution/node-execution-runtime-fields.ts',
    'apps/worker/src/execution/node-runtime-capabilities.ts',
    'apps/worker/src/execution/preview-attempt-runtime.ts',
    'apps/worker/src/execution/provider-connection-runtime.ts',
    'apps/worker/src/runtime/worker-process-shutdown.ts',
    'apps/worker/src/runtime/worker-readiness-monitor.ts',
    'apps/worker/src/runtime/worker-readiness.ts',
    'apps/worker/src/transport/node-attempt-runtime-provider.ts',
  ],
  'worker-entrypoints': ['apps/worker/src/main.ts'],
  'workflow-engine': [
    'packages/workflow-engine/src/advance-workflow.ts',
    'packages/workflow-engine/src/checkpoint-executable-validation.ts',
    'packages/workflow-engine/src/checkpoint-identity.ts',
    'packages/workflow-engine/src/checkpoint-shared.ts',
    'packages/workflow-engine/src/checkpoint-v1-join.ts',
    'packages/workflow-engine/src/checkpoint-v1-loop.ts',
    'packages/workflow-engine/src/checkpoint-v1.ts',
    'packages/workflow-engine/src/checkpoint-v2.ts',
    'packages/workflow-engine/src/checkpoint.ts',
    'packages/workflow-engine/src/coordinator-failures.ts',
    'packages/workflow-engine/src/coordinator-observations.ts',
    'packages/workflow-engine/src/coordinator-output.ts',
    'packages/workflow-engine/src/core-definition-identities.ts',
    'packages/workflow-engine/src/errors.ts',
    'packages/workflow-engine/src/executable-boundary.ts',
    'packages/workflow-engine/src/executable-compatibility.ts',
    'packages/workflow-engine/src/executable-compilation.ts',
    'packages/workflow-engine/src/executable-foundation.ts',
    'packages/workflow-engine/src/executable-graph-boundary.ts',
    'packages/workflow-engine/src/executable-graph-rules.ts',
    'packages/workflow-engine/src/executable-graph-validation-index.ts',
    'packages/workflow-engine/src/executable-graph.ts',
    'packages/workflow-engine/src/executable-identity.ts',
    'packages/workflow-engine/src/executable-validation.ts',
    'packages/workflow-engine/src/graph-scheduler-indexes.ts',
    'packages/workflow-engine/src/graph-scheduler.ts',
    'packages/workflow-engine/src/node-attempt-input.ts',
    'packages/workflow-engine/src/operation-values.ts',
    'packages/workflow-engine/src/operations.ts',
    'packages/workflow-engine/src/ordering.ts',
    'packages/workflow-engine/src/output-reference.ts',
    'packages/workflow-engine/src/persisted-observation-parser.ts',
    'packages/workflow-engine/src/persisted-observations.ts',
    'packages/workflow-engine/src/retries.ts',
    'packages/workflow-engine/src/runtime.ts',
    'packages/workflow-engine/src/scheduling.ts',
    'packages/workflow-engine/src/scope.ts',
    'packages/workflow-engine/src/server-only.ts',
    'packages/workflow-engine/src/testing-graph.ts',
    'packages/workflow-engine/src/testing.ts',
    'packages/workflow-engine/src/transition-decisions.ts',
    'packages/workflow-engine/src/transitions.ts',
    'packages/workflow-engine/src/types.ts',
    'packages/workflow-engine/src/workflow-transition-derived.ts',
    'packages/workflow-engine/src/workflow-transition-observations.ts',
    'packages/workflow-engine/src/workflow-transition-plan.ts',
    'packages/workflow-engine/src/workflow-transition-state.ts',
    'packages/workflow-engine/src/workflow-transition-stops.ts',
  ],
});

async function typescriptFilesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFilesBelow(item)));
    else if (entry.isFile() && item.endsWith('.ts') && !item.endsWith('.d.ts'))
      files.push(item);
  }
  return files;
}

export async function riskCoverageCohortFileInventories(rootDirectory) {
  const inventories = new Map(
    Object.entries(EXACT_RISK_COHORT_FILES).map(([cohort, files]) => [
      cohort,
      [...files].sort(),
    ]),
  );
  await Promise.all(
    Object.entries(EXHAUSTIVE_RISK_COHORT_DIRECTORIES).map(
      async ([cohort, directory]) => {
        const files = await typescriptFilesBelow(
          path.join(rootDirectory, directory),
        );
        inventories.set(
          cohort,
          files.map((file) => path.relative(rootDirectory, file)).sort(),
        );
      },
    ),
  );
  const defined = [...inventories.keys()].sort();
  const required = [...RISK_COVERAGE_COHORTS].sort();
  if (JSON.stringify(defined) !== JSON.stringify(required))
    throw new Error('Risk-coverage cohort file inventories are incomplete');
  return inventories;
}

export const RISK_COVERAGE_POLICIES = Object.freeze({
  'artifact-store': { mode: 'strict' },
  contracts: { mode: 'strict' },
  integrations: { mode: 'strict' },
  'workflow-engine': { mode: 'strict' },
  database: { mode: 'strict' },
  worker: { mode: 'strict' },
  api: { mode: 'strict' },
  'api-priority': { mode: 'strict' },
  'api-orchestration': { mode: 'strict' },
  'lifecycle-command': { mode: 'strict' },
  'api-entrypoints': { mode: 'strict' },
  'worker-entrypoints': { mode: 'strict' },
  'operator-command-entrypoints': { mode: 'strict' },
  'recovery-entrypoints': { mode: 'strict' },
  'retention-entrypoints': { mode: 'strict' },
});

function coverageInstrumentation(coverage) {
  return {
    path: coverage.path,
    statementMap: coverage.statementMap,
    fnMap: coverage.fnMap,
    branchMap: coverage.branchMap,
    meta: coverage.meta,
  };
}

export function partitionApiPriorityCoverage(reports) {
  const api = reports.get('api');
  const priority = reports.get('api-priority');
  if (api === undefined) throw new Error('Missing api risk-coverage input');
  if (priority === undefined)
    throw new Error('Missing api-priority risk-coverage input');

  const uniquePriority = {};
  for (const [file, coverage] of Object.entries(priority)) {
    const existing = api[file];
    if (existing === undefined) {
      uniquePriority[file] = coverage;
      continue;
    }
    if (
      JSON.stringify(coverageInstrumentation(existing)) !==
      JSON.stringify(coverageInstrumentation(coverage))
    )
      throw new Error(
        `Mismatched API risk-coverage instrumentation for overlapping source: ${file}`,
      );
    if (
      JSON.stringify({ s: existing.s, f: existing.f, b: existing.b }) !==
      JSON.stringify({ s: coverage.s, f: coverage.f, b: coverage.b })
    )
      throw new Error(
        `Mismatched API risk-coverage hits for overlapping source: ${file}`,
      );
  }
  reports.set('api-priority', uniquePriority);
}

function branchKey(branch) {
  return [
    branch.cohort,
    branch.file,
    branch.branchId,
    branch.locationIndex,
    branch.branchType,
    branch.line,
    branch.column,
  ].join(':');
}

export function normalizedSourceSpan(source, location) {
  const startLine = location?.start?.line;
  const endLine = location?.end?.line;
  const startColumn = location?.start?.column;
  const endColumn = location?.end?.column;
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    !Number.isInteger(endLine) ||
    endLine < startLine ||
    !Number.isInteger(startColumn) ||
    startColumn < 0 ||
    !Number.isInteger(endColumn) ||
    endColumn < 0
  )
    return source;
  const lines = source.split('\n');
  const startText = lines[startLine - 1];
  const endText = lines[endLine - 1];
  if (
    startText === undefined ||
    endText === undefined ||
    startColumn > startText.length ||
    endColumn > endText.length ||
    (startLine === endLine && endColumn < startColumn)
  )
    return source;
  const lineOffset = (line) =>
    lines
      .slice(0, line - 1)
      .reduce((offset, text) => offset + text.length + 1, 0);
  const startOffset = lineOffset(startLine) + startColumn;
  const endOffset = lineOffset(endLine) + endColumn;
  return source.slice(startOffset, endOffset);
}

function sourceFingerprint(source, metadata, locationIndex) {
  const location = metadata.locations?.[locationIndex] ?? metadata.loc;
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        decision: normalizedSourceSpan(source, metadata.loc),
        branch: normalizedSourceSpan(source, location),
      }),
    )
    .digest('hex')}`;
}

function matchingExecutedTest(result, evidence) {
  if (result?.success !== true || !Array.isArray(result.testResults))
    return false;
  return result.testResults.some(
    (suite) =>
      typeof suite?.name === 'string' &&
      (suite.name === evidence.testFile ||
        suite.name.endsWith(`/${evidence.testFile}`)) &&
      Array.isArray(suite.assertionResults) &&
      suite.assertionResults.some(
        (assertion) =>
          assertion?.title === evidence.testName &&
          assertion.status === 'passed',
      ),
  );
}

function resultSha256(result) {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

function invalidProducerInterval() {
  throw new Error(
    'Integration test result was not produced within the qualification interval',
  );
}

function assertFiniteProducerInterval(result, startedAt, completedAt) {
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt
  )
    invalidProducerInterval();
  if (
    !Number.isFinite(result.startTime) ||
    result.startTime < startedAt ||
    result.startTime > completedAt
  )
    invalidProducerInterval();
}

function assertCompletePassedAssertions(result, assertions) {
  if (
    !Array.isArray(result.testResults) ||
    result.testResults.length === 0 ||
    assertions.length !== result.numTotalTests
  )
    invalidProducerInterval();
  if (
    assertions.some(
      (assertion) =>
        typeof assertion?.title !== 'string' || assertion.status !== 'passed',
    )
  )
    invalidProducerInterval();
}

function assertSuitesCompletedWithinInterval(result, completedAt) {
  if (
    result.testResults.some(
      (suite) =>
        typeof suite?.name !== 'string' ||
        !Number.isFinite(suite?.endTime) ||
        suite.endTime < result.startTime ||
        suite.endTime > completedAt ||
        !Array.isArray(suite.assertionResults),
    )
  )
    invalidProducerInterval();
}

function assertProducedResultInterval(result, startedAt, completedAt) {
  validateVitestGateReport(result, 'Integration evidence producer', 1, 0);
  const assertions = Array.isArray(result.testResults)
    ? result.testResults.flatMap((suite) => suite.assertionResults ?? [])
    : [];
  assertFiniteProducerInterval(result, startedAt, completedAt);
  assertCompletePassedAssertions(result, assertions);
  assertSuitesCompletedWithinInterval(result, completedAt);
}

function assertCompleteProducerIdentity(identity) {
  const identityValues = [
    identity.artifactFile,
    identity.resultFile,
    identity.command,
    identity.candidateFingerprint,
    identity.runId,
    identity.sourceRevision,
  ];
  if (
    identityValues.some(
      (value) => typeof value !== 'string' || value.length === 0,
    )
  )
    throw new Error('Integration evidence producer identity is incomplete');
}

export async function produceIntegrationEvidenceArtifact(
  {
    artifactFile,
    candidateFingerprint,
    command,
    completedAt,
    resultFile,
    runId,
    sourceRevision,
    startedAt,
  },
  operations = {},
) {
  const readResult = operations.readFile ?? readFile;
  const writeArtifact = operations.writeFile ?? writeFile;
  assertCompleteProducerIdentity({
    artifactFile,
    candidateFingerprint,
    command,
    resultFile,
    runId,
    sourceRevision,
  });
  const result = JSON.parse(await readResult(resultFile, 'utf8'));
  assertProducedResultInterval(result, startedAt, completedAt);
  const artifact = {
    schemaVersion: 3,
    command,
    sourceRevision,
    candidateFingerprint,
    runId,
    producerInterval: { startedAt, completedAt },
    resultSha256: resultSha256(result),
    result,
  };
  await writeArtifact(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`, {
    flag: 'wx',
  });
  return artifact;
}

function validatedIntegrationEvidence(
  evidence,
  sourceRevision,
  execution = {},
) {
  const entries = new Map();
  for (const [id, item] of Object.entries(evidence)) {
    assertIntegrationEvidenceIdentity(id, item);
    if ('execution' in item)
      throw new Error(`Inline integration execution is not an artifact: ${id}`);
    const resultArtifact = item.resultArtifact;
    const executed = resultArtifact !== undefined;
    if (executed)
      assertExecutedIntegrationEvidence(
        id,
        item,
        resultArtifact,
        sourceRevision,
        execution,
      );
    if (execution.requireExecuted === true && !executed)
      throw new Error(`Missing executed integration evidence: ${id}`);
    const publicEvidence = Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== 'resultArtifact'),
    );
    entries.set(id, {
      ...publicEvidence,
      evidenceState: executed ? 'executed' : 'referenced-only',
      ...(executed
        ? {
            runId: resultArtifact.runId,
            candidateFingerprint: resultArtifact.candidateFingerprint,
          }
        : {}),
    });
  }
  return entries;
}

function assertIntegrationEvidenceIdentity(id, item) {
  const command = item?.command;
  const isIntegrationCommand =
    typeof command === 'string' &&
    (command.includes('test:integration') ||
      (command.includes('exec vitest run') &&
        command.includes('vitest.integration')));
  if (
    !/^[a-z0-9][a-z0-9-]*$/u.test(id) ||
    typeof item?.command !== 'string' ||
    !isIntegrationCommand ||
    typeof item.testFile !== 'string' ||
    !item.testFile.endsWith('.integration.test.ts') ||
    typeof item.testName !== 'string' ||
    item.testName.trim().length < 5
  )
    throw new Error(`Invalid integration evidence: ${id}`);
}

function assertExecutedIntegrationEvidence(
  id,
  item,
  artifact,
  sourceRevision,
  execution,
) {
  const identityMatches =
    artifact?.schemaVersion === 3 &&
    artifact.command === item.command &&
    artifact.sourceRevision === sourceRevision &&
    artifact.candidateFingerprint === execution.candidateFingerprint &&
    artifact.runId === execution.runId;
  if (!identityMatches)
    throw new Error(`Invalid executed integration evidence: ${id}`);
  if (artifact.resultSha256 !== resultSha256(artifact.result))
    throw new Error(`Invalid executed integration evidence: ${id}`);
  try {
    assertProducedResultInterval(
      artifact.result,
      artifact.producerInterval?.startedAt,
      artifact.producerInterval?.completedAt,
    );
  } catch {
    throw new Error(`Invalid executed integration evidence: ${id}`);
  }
  if (!matchingExecutedTest(artifact.result, item))
    throw new Error(`Invalid executed integration evidence: ${id}`);
}

export function riskCoverageSourceRevision(sourceByFile) {
  const digest = createHash('sha256');
  for (const [file, source] of [...sourceByFile.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    digest.update(file);
    digest.update('\0');
    digest.update(source);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

export function flattenRiskCoverageReviewGroups(groups) {
  const seen = new Set();
  return groups.flatMap((group) => {
    if (
      typeof group?.cohort !== 'string' ||
      typeof group.file !== 'string' ||
      !Array.isArray(group.reviews)
    )
      throw new Error('Invalid risk-coverage review group');
    const key = `${group.cohort}:${group.file}`;
    if (seen.has(key))
      throw new Error(`Duplicate risk-coverage review group: ${key}`);
    seen.add(key);
    return group.reviews.map((review) => ({
      cohort: group.cohort,
      file: group.file,
      ...review,
    }));
  });
}

function validatedReviews(reviews) {
  const byKey = new Map();
  for (const review of reviews) {
    if (
      !REVIEW_CLASSIFICATIONS.has(review.classification) ||
      typeof review.branchId !== 'string' ||
      !Number.isInteger(review.locationIndex) ||
      review.locationIndex < 0 ||
      !/^sha256:[\da-f]{64}$/u.test(review.sourceFingerprint) ||
      typeof review.justification !== 'string' ||
      review.justification.trim().length < 20
    ) {
      throw new Error(`Invalid risk-coverage review: ${branchKey(review)}`);
    }
    const key = branchKey(review);
    if (byKey.has(key)) {
      throw new Error(`Duplicate risk-coverage review: ${key}`);
    }
    byKey.set(key, review);
  }
  return byKey;
}

function ratio(covered, total) {
  return {
    covered,
    total,
    percent: total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100,
  };
}

function coverageEntries(coverage, counterName, metadataName, file) {
  const counters = coverage?.[counterName];
  const metadata = coverage?.[metadataName];
  if (
    counters === undefined ||
    metadata === undefined ||
    counters === null ||
    typeof counters !== 'object' ||
    Array.isArray(counters) ||
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  )
    throw new Error(`Malformed Istanbul ${counterName} coverage for ${file}`);
  const counterKeys = Object.keys(counters).sort();
  const metadataKeys = Object.keys(metadata).sort();
  if (JSON.stringify(counterKeys) !== JSON.stringify(metadataKeys))
    throw new Error(
      `Mismatched Istanbul ${counterName} coverage metadata for ${file}`,
    );
  const entries = Object.entries(counters);
  const hits =
    counterName === 'b'
      ? entries.flatMap(([, values]) =>
          Array.isArray(values) ? values : [Number.NaN],
        )
      : entries.map(([, value]) => value);
  if (hits.some((hit) => !Number.isSafeInteger(hit) || hit < 0))
    throw new Error(`Malformed Istanbul ${counterName} hits for ${file}`);
  return entries;
}

export function coverageMetrics(report) {
  let coveredStatements = 0;
  let totalStatements = 0;
  let coveredBranches = 0;
  let totalBranches = 0;
  let coveredFunctions = 0;
  let totalFunctions = 0;
  let coveredLines = 0;
  let totalLines = 0;
  for (const [file, coverage] of Object.entries(report)) {
    const statements = coverageEntries(coverage, 's', 'statementMap', file);
    coveredStatements += statements.filter(([, hits]) => hits > 0).length;
    totalStatements += statements.length;
    const branches = coverageEntries(coverage, 'b', 'branchMap', file).flatMap(
      ([, hits]) => hits,
    );
    coveredBranches += branches.filter((hits) => hits > 0).length;
    totalBranches += branches.length;
    const functions = coverageEntries(coverage, 'f', 'fnMap', file).map(
      ([, hits]) => hits,
    );
    coveredFunctions += functions.filter((hits) => hits > 0).length;
    totalFunctions += functions.length;
    const lines = new Map();
    for (const [statementId, hits] of statements) {
      const line = coverage.statementMap?.[statementId]?.start?.line;
      if (!Number.isInteger(line)) continue;
      lines.set(line, (lines.get(line) ?? 0) + hits);
    }
    coveredLines += [...lines.values()].filter((hits) => hits > 0).length;
    totalLines += lines.size;
  }
  return {
    statements: ratio(coveredStatements, totalStatements),
    branches: ratio(coveredBranches, totalBranches),
    functions: ratio(coveredFunctions, totalFunctions),
    lines: ratio(coveredLines, totalLines),
  };
}

export function summarizeVitestResult(result) {
  validateVitestGateReport(result, 'Risk coverage test result', 1, 0);
  const endTime = Math.max(
    result.startTime,
    ...result.testResults.map((testResult) => testResult.endTime),
  );
  return {
    durationMs: Math.round((endTime - result.startTime) * 100) / 100,
    totalTests: result.numTotalTests,
    passedTests: result.numPassedTests,
    failedTests: result.numFailedTests,
    skippedTests: result.numPendingTests,
    todoTests: result.numTodoTests,
    retryPolicy: 'disabled-by-configuration',
  };
}

export function uncoveredBranches(
  report,
  cohort,
  rootDirectory,
  sourceByFile = new Map(),
) {
  const uncovered = [];
  for (const [file, coverage] of Object.entries(report)) {
    for (const [branchId, hits] of coverageEntries(
      coverage,
      'b',
      'branchMap',
      file,
    )) {
      const metadata = coverage.branchMap?.[branchId];
      if (
        !Array.isArray(metadata?.locations) ||
        metadata.locations.length !== hits.length
      )
        throw new Error(`Malformed Istanbul branch locations for ${file}`);
      for (const [index, hitCount] of hits.entries()) {
        if (hitCount !== 0) continue;
        const location = metadata.locations?.[index] ?? metadata.loc;
        const source = sourceByFile.get(file);
        uncovered.push({
          cohort,
          file:
            rootDirectory === undefined
              ? file
              : path.relative(rootDirectory, file),
          branchId,
          locationIndex: index,
          branchType: metadata.type,
          line: location?.start?.line ?? 0,
          column: location?.start?.column ?? 0,
          ...(source === undefined
            ? {}
            : {
                sourceFingerprint: sourceFingerprint(source, metadata, index),
              }),
          reviewStatus: 'unreviewed',
          evidenceState: 'unreviewed',
        });
      }
    }
  }
  return uncovered.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.branchId.localeCompare(right.branchId, undefined, {
        numeric: true,
      }) ||
      left.locationIndex - right.locationIndex,
  );
}

export function createRiskCoverageReport(
  reports,
  rootDirectory,
  generatedAt = new Date(),
  reviews = [],
  integrationEvidence = {},
  sourceByFile = new Map(),
  testHealthByCohort = new Map(),
  sourceRevision,
  integrationExecution = {},
) {
  const selections = [...reports.entries()]
    .map(([cohort, report]) => {
      const testHealth = testHealthByCohort.get(cohort);
      return {
        cohort,
        files: Object.keys(report)
          .map((file) => path.relative(rootDirectory, file))
          .sort(),
        metrics: coverageMetrics(report),
        ...(testHealth === undefined ? {} : { testHealth }),
      };
    })
    .sort((left, right) => left.cohort.localeCompare(right.cohort));
  const reviewByKey = validatedReviews(reviews);
  const integrationEvidenceById = validatedIntegrationEvidence(
    integrationEvidence,
    sourceRevision,
    integrationExecution,
  );
  const branches = [...reports.entries()].flatMap(([cohort, report]) =>
    uncoveredBranches(report, cohort, rootDirectory, sourceByFile),
  );
  const reviewedBranches = new Set();
  const classifiedBranches = branches.map((branch) => {
    const key = branchKey(branch);
    const review = reviewByKey.get(key);
    if (review === undefined) return branch;
    if (branch.sourceFingerprint !== review.sourceFingerprint)
      throw new Error(`Stale risk-coverage source fingerprint: ${key}`);
    const evidence =
      review.classification === 'integration'
        ? integrationEvidenceById.get(review.evidenceId)
        : undefined;
    if (review.classification === 'integration' && evidence === undefined)
      throw new Error(`Missing integration evidence: ${key}`);
    reviewedBranches.add(key);
    return {
      ...branch,
      reviewStatus: 'reviewed',
      classification: review.classification,
      justification: review.justification,
      evidenceState:
        evidence === undefined ? 'reviewed-uncovered' : evidence.evidenceState,
      ...(evidence === undefined
        ? {}
        : { evidenceId: review.evidenceId, evidence }),
    };
  });
  const staleReviews = [...reviewByKey.keys()].filter(
    (key) => !reviewedBranches.has(key),
  );
  if (staleReviews.length > 0) {
    throw new Error(`Stale risk-coverage reviews: ${staleReviews.join(', ')}`);
  }
  const reviewedCount = reviewedBranches.size;
  const unreviewedCount = classifiedBranches.length - reviewedCount;
  return {
    schemaVersion: 7,
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    scope: {
      kind: 'selected-critical-module-files',
      cohorts: selections,
    },
    classification: {
      status:
        reviewedCount === 0
          ? 'unreviewed'
          : unreviewedCount === 0
            ? 'reviewed'
            : 'partially-reviewed',
      reviewedCount,
      unreviewedCount,
    },
    generatedAt: generatedAt.toISOString(),
    uncoveredBranches: classifiedBranches,
  };
}

export function assertNoUnreviewedBranches(report, cohort) {
  const unreviewed = report.uncoveredBranches.filter(
    (branch) =>
      branch.cohort === cohort && branch.reviewStatus === 'unreviewed',
  );
  if (unreviewed.length > 0)
    throw new Error(
      `Unreviewed ${cohort} risk-coverage branches: ${String(unreviewed.length)}`,
    );
}

export function assertRiskCoverageCohort(report, cohort, expectedFiles) {
  const selection = report.scope.cohorts.find(
    (candidate) => candidate.cohort === cohort,
  );
  if (selection === undefined)
    throw new Error(`Missing ${cohort} risk-coverage cohort`);
  const actualFiles = [...selection.files].sort();
  const requiredFiles = [...expectedFiles].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(requiredFiles))
    throw new Error(`Unexpected ${cohort} risk-coverage file inventory`);
  assertNoUnreviewedBranches(report, cohort);
}

export function assertRiskCoveragePolicies(
  report,
  policies = RISK_COVERAGE_POLICIES,
) {
  for (const [cohort, policy] of Object.entries(policies)) {
    const unreviewed = report.uncoveredBranches.filter(
      (branch) =>
        branch.cohort === cohort && branch.reviewStatus === 'unreviewed',
    ).length;
    if (policy.mode === 'strict' && unreviewed > 0)
      throw new Error(
        `Unreviewed ${cohort} risk-coverage branches: ${String(unreviewed)}`,
      );
    if (policy.mode === 'debt-ceiling' && unreviewed > policy.maximumUnreviewed)
      throw new Error(
        `Unreviewed ${cohort} risk-coverage debt exceeds ceiling ${String(policy.maximumUnreviewed)}: ${String(unreviewed)}`,
      );
  }
}

async function main(environment = process.env) {
  const reports = new Map();
  const sourceByFile = new Map();
  const testHealthByCohort = new Map();
  for (const cohort of RISK_COVERAGE_COHORTS) {
    const report = JSON.parse(
      await readFile(`coverage/${cohort}/coverage-final.json`, 'utf8'),
    );
    reports.set(cohort, report);
    testHealthByCohort.set(
      cohort,
      summarizeVitestResult(
        JSON.parse(
          await readFile(`coverage/${cohort}/test-results.json`, 'utf8'),
        ),
      ),
    );
    await Promise.all(
      Object.keys(report).map(async (file) => {
        sourceByFile.set(file, await readFile(file, 'utf8'));
      }),
    );
  }
  partitionApiPriorityCoverage(reports);
  const reviewManifest = JSON.parse(
    await readFile(
      'infrastructure/coverage/risk-coverage-reviews.json',
      'utf8',
    ),
  );
  if (
    reviewManifest.schemaVersion !== 4 ||
    !Array.isArray(reviewManifest.reviewGroups) ||
    reviewManifest.integrationEvidence === null ||
    typeof reviewManifest.integrationEvidence !== 'object'
  ) {
    throw new Error('Risk-coverage review manifest must use schema version 4');
  }
  await Promise.all(
    Object.values(reviewManifest.integrationEvidence).map(async (evidence) => {
      const contents = await readFile(evidence.testFile, 'utf8');
      if (!contents.includes(evidence.testName))
        throw new Error(
          `Integration evidence test name is stale: ${evidence.testFile}`,
        );
    }),
  );
  const sourceRevision = riskCoverageSourceRevision(sourceByFile);
  const executedReportFile = environment.PERTEXO_RISK_COVERAGE_RESULT_FILE;
  const executedArtifactFile = environment.PERTEXO_RISK_COVERAGE_EVIDENCE_FILE;
  const execution = {
    candidateFingerprint:
      environment.PERTEXO_RISK_COVERAGE_CANDIDATE_FINGERPRINT,
    runId: environment.PERTEXO_RISK_COVERAGE_RUN_ID,
    requireExecuted: environment.PERTEXO_RISK_COVERAGE_REQUIRE_EXECUTED === '1',
  };
  if (execution.requireExecuted && executedReportFile === undefined)
    throw new Error('Required run-linked integration evidence is missing');
  if (
    executedReportFile !== undefined &&
    (typeof execution.candidateFingerprint !== 'string' ||
      execution.candidateFingerprint.length === 0 ||
      typeof execution.runId !== 'string' ||
      execution.runId.length === 0)
  )
    throw new Error('Run-linked integration evidence identity is incomplete');
  const executedArtifact =
    executedReportFile === undefined
      ? undefined
      : await produceIntegrationEvidenceArtifact({
          artifactFile: executedArtifactFile,
          candidateFingerprint: execution.candidateFingerprint,
          command: environment.PERTEXO_RISK_COVERAGE_COMMAND,
          completedAt: Number(
            environment.PERTEXO_RISK_COVERAGE_PRODUCER_COMPLETED_AT,
          ),
          resultFile: executedReportFile,
          runId: execution.runId,
          sourceRevision,
          startedAt: Number(
            environment.PERTEXO_RISK_COVERAGE_PRODUCER_STARTED_AT,
          ),
        });
  const integrationEvidence = Object.fromEntries(
    await Promise.all(
      Object.entries(reviewManifest.integrationEvidence).map(
        async ([id, evidence]) => [
          id,
          executedArtifact === undefined
            ? evidence
            : {
                ...evidence,
                resultArtifact: executedArtifact,
              },
        ],
      ),
    ),
  );
  const output = createRiskCoverageReport(
    reports,
    process.cwd(),
    new Date(),
    flattenRiskCoverageReviewGroups(reviewManifest.reviewGroups),
    integrationEvidence,
    sourceByFile,
    testHealthByCohort,
    sourceRevision,
    execution,
  );
  const expectedInventories = await riskCoverageCohortFileInventories(
    process.cwd(),
  );
  for (const [cohort, files] of expectedInventories) {
    assertRiskCoverageCohort(output, cohort, files);
  }
  assertRiskCoveragePolicies(output);
  await writeFile(
    'coverage/risk-uncovered-branches.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );
  const fileCount = output.scope.cohorts.reduce(
    (total, cohort) => total + cohort.files.length,
    0,
  );
  console.log(
    `Recorded ${String(output.classification.unreviewedCount)} unreviewed and ${String(output.classification.reviewedCount)} reviewed uncovered branches across ${String(fileCount)} selected files and ${String(output.scope.cohorts.reduce((total, cohort) => total + cohort.metrics.lines.total, 0))} coverable lines.`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  await main();
