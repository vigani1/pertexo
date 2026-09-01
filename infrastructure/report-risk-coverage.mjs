#!/usr/bin/env node

import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function uncoveredBranches(report, cohort) {
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
          file,
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
) {
  const selections = [...reports.entries()]
    .map(([cohort, report]) => ({
      cohort,
      files: Object.keys(report)
        .map((file) => path.relative(rootDirectory, file))
        .sort(),
    }))
    .sort((left, right) => left.cohort.localeCompare(right.cohort));
  const branches = [...reports.entries()].flatMap(([cohort, report]) =>
    uncoveredBranches(report, cohort),
  );
  return {
    schemaVersion: 2,
    scope: {
      kind: 'selected-critical-module-files',
      cohorts: selections,
    },
    classification: {
      status: 'unreviewed',
      reviewedCount: 0,
    },
    generatedAt: generatedAt.toISOString(),
    uncoveredBranches: branches,
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
  const output = createRiskCoverageReport(reports, process.cwd());
  await writeFile(
    'coverage/risk-uncovered-branches.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );
  const fileCount = output.scope.cohorts.reduce(
    (total, cohort) => total + cohort.files.length,
    0,
  );
  console.log(
    `Recorded ${output.uncoveredBranches.length} unreviewed uncovered branches across ${fileCount} selected files.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
