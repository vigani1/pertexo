#!/usr/bin/env node

import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REVIEW_CLASSIFICATIONS = new Set([
  'defensive',
  'unreachable',
  'generated',
]);

function branchKey(branch) {
  return [
    branch.cohort,
    branch.file,
    branch.branchType,
    branch.line,
    branch.column,
  ].join(':');
}

function validatedReviews(reviews) {
  const byKey = new Map();
  for (const review of reviews) {
    if (
      !REVIEW_CLASSIFICATIONS.has(review.classification) ||
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

export function uncoveredBranches(report, cohort, rootDirectory) {
  const uncovered = [];
  for (const [file, coverage] of Object.entries(report)) {
    for (const [branchId, hits] of Object.entries(coverage.b ?? {})) {
      const metadata = coverage.branchMap?.[branchId];
      if (metadata === undefined) continue;
      for (const [index, hitCount] of hits.entries()) {
        if (hitCount !== 0) continue;
        const location = metadata.locations?.[index] ?? metadata.loc;
        uncovered.push({
          cohort,
          file:
            rootDirectory === undefined
              ? file
              : path.relative(rootDirectory, file),
          branchType: metadata.type,
          line: location?.start?.line ?? 0,
          column: location?.start?.column ?? 0,
          reviewStatus: 'unreviewed',
        });
      }
    }
  }
  return uncovered.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column,
  );
}

export function createRiskCoverageReport(
  reports,
  rootDirectory,
  generatedAt = new Date(),
  reviews = [],
) {
  const selections = [...reports.entries()]
    .map(([cohort, report]) => ({
      cohort,
      files: Object.keys(report)
        .map((file) => path.relative(rootDirectory, file))
        .sort(),
    }))
    .sort((left, right) => left.cohort.localeCompare(right.cohort));
  const reviewByKey = validatedReviews(reviews);
  const branches = [...reports.entries()].flatMap(([cohort, report]) =>
    uncoveredBranches(report, cohort, rootDirectory),
  );
  const reviewedBranches = new Set();
  const classifiedBranches = branches.map((branch) => {
    const key = branchKey(branch);
    const review = reviewByKey.get(key);
    if (review === undefined) return branch;
    reviewedBranches.add(key);
    return {
      ...branch,
      reviewStatus: 'reviewed',
      classification: review.classification,
      justification: review.justification,
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
    schemaVersion: 3,
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
  const cohorts = ['workflow-engine', 'database', 'worker', 'api'];
  const reports = new Map();
  for (const cohort of cohorts) {
    reports.set(
      cohort,
      JSON.parse(
        await readFile(`coverage/${cohort}/coverage-final.json`, 'utf8'),
      ),
    );
  }
  const reviewManifest = JSON.parse(
    await readFile('infrastructure/risk-coverage-reviews.json', 'utf8'),
  );
  if (
    reviewManifest.schemaVersion !== 1 ||
    !Array.isArray(reviewManifest.reviews)
  ) {
    throw new Error('Risk-coverage review manifest must use schema version 1');
  }
  const output = createRiskCoverageReport(
    reports,
    process.cwd(),
    new Date(),
    reviewManifest.reviews,
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
    `Recorded ${String(output.classification.unreviewedCount)} unreviewed and ${String(output.classification.reviewedCount)} reviewed uncovered branches across ${String(fileCount)} selected files.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
