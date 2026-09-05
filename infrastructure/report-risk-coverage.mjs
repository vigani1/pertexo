#!/usr/bin/env node

import console from 'node:console';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REVIEW_CLASSIFICATIONS = new Set([
  'defensive',
  'unreachable',
  'generated',
  'integration',
]);

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

function normalizedSourceSpan(source, location) {
  const startLine = location?.start?.line;
  const endLine = location?.end?.line;
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    !Number.isInteger(endLine) ||
    endLine < startLine
  )
    return source;
  const lines = source.split('\n');
  const selected = lines.slice(startLine - 1, endLine);
  if (selected.length === 0) return source;
  const startColumn = location.start.column;
  const endColumn = location.end.column;
  if (Number.isInteger(startColumn) && startColumn > 0)
    selected[0] = selected[0]?.slice(startColumn) ?? '';
  if (Number.isInteger(endColumn) && endColumn >= 0)
    selected[selected.length - 1] =
      selected[selected.length - 1]?.slice(0, endColumn) ?? '';
  return selected.join('\n').replace(/\s+/gu, ' ').trim();
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

function validatedIntegrationEvidence(evidence) {
  const entries = new Map();
  for (const [id, item] of Object.entries(evidence)) {
    if (
      !/^[a-z0-9][a-z0-9-]*$/u.test(id) ||
      typeof item?.command !== 'string' ||
      !item.command.includes('test:integration') ||
      typeof item.testFile !== 'string' ||
      !item.testFile.endsWith('.integration.test.ts') ||
      typeof item.testName !== 'string' ||
      item.testName.trim().length < 5
    )
      throw new Error(`Invalid integration evidence: ${id}`);
    entries.set(id, item);
  }
  return entries;
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

export function coverageMetrics(report) {
  let coveredStatements = 0;
  let totalStatements = 0;
  let coveredBranches = 0;
  let totalBranches = 0;
  let coveredFunctions = 0;
  let totalFunctions = 0;
  let coveredLines = 0;
  let totalLines = 0;
  for (const coverage of Object.values(report)) {
    const statements = Object.entries(coverage.s ?? {});
    coveredStatements += statements.filter(([, hits]) => hits > 0).length;
    totalStatements += statements.length;
    const branches = Object.values(coverage.b ?? {}).flat();
    coveredBranches += branches.filter((hits) => hits > 0).length;
    totalBranches += branches.length;
    const functions = Object.values(coverage.f ?? {});
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
    retryPolicy: 'disabled',
    retryAttempts: 0,
    flakyTests: 0,
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
    for (const [branchId, hits] of Object.entries(coverage.b ?? {})) {
      const metadata = coverage.branchMap?.[branchId];
      if (metadata === undefined) continue;
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
  const integrationEvidenceById =
    validatedIntegrationEvidence(integrationEvidence);
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
    schemaVersion: 6,
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

async function main() {
  const cohorts = [
    'artifact-store',
    'contracts',
    'workflow-engine',
    'database',
    'worker',
    'api',
  ];
  const reports = new Map();
  const sourceByFile = new Map();
  const testHealthByCohort = new Map();
  for (const cohort of cohorts) {
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
  const reviewManifest = JSON.parse(
    await readFile('infrastructure/risk-coverage-reviews.json', 'utf8'),
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
  const output = createRiskCoverageReport(
    reports,
    process.cwd(),
    new Date(),
    flattenRiskCoverageReviewGroups(reviewManifest.reviewGroups),
    reviewManifest.integrationEvidence,
    sourceByFile,
    testHealthByCohort,
  );
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
