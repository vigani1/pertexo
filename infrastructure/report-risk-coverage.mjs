#!/usr/bin/env node

import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
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
          classification: 'testable',
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

async function main() {
  const cohorts = ['workflow-engine', 'database', 'worker', 'api'];
  const branches = [];
  for (const cohort of cohorts) {
    const report = JSON.parse(
      await readFile(`coverage/${cohort}/coverage-final.json`, 'utf8'),
    );
    branches.push(...uncoveredBranches(report, cohort));
  }
  const output = {
    schemaVersion: 1,
    scope:
      'security, transaction, recovery, parser, and state-transition coverage cohorts',
    generatedAt: new Date().toISOString(),
    uncoveredBranches: branches,
  };
  await writeFile(
    'coverage/risk-uncovered-branches.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log(`Recorded ${branches.length} testable uncovered risk branches.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
