import { createHash } from 'node:crypto';
import console from 'node:console';
import { globSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { preserveTemporaryDirectoryFailure } from '../support/temporary-directory-cleanup.mjs';
import {
  describeBoundedChildFailure,
  runBoundedChildProcess,
} from '../support/bounded-child-process.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const baselinePath = new URL(
  './test-duplication-baseline.json',
  import.meta.url,
);
const retainedClassifications = new Set([
  'intentional-scenario-local',
  'false-positive',
]);

function cloneHash(fragment) {
  return createHash('sha256').update(fragment).digest('hex');
}

function pairKey(first, second) {
  return [first, second].sort().join('\u0000');
}

function actualClones(report) {
  return report.duplicates.map((clone) => ({
    hash: cloneHash(clone.fragment),
    lines: clone.lines,
    pair: pairKey(clone.firstFile.name, clone.secondFile.name),
  }));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateCloneReport(scopeName, scope, report) {
  const failures = [];
  if (!isRecord(report)) return [`${scopeName}: jscpd report is malformed`];
  if (!Array.isArray(report.duplicates))
    return [`${scopeName}: jscpd duplicates are missing`];
  const totals = report.statistics?.total;
  if (!isRecord(totals)) return [`${scopeName}: jscpd totals are missing`];

  for (const field of Object.keys(scope.maximums)) {
    if (!validCount(totals[field]))
      failures.push(`${scopeName}: jscpd total ${field} is invalid`);
  }
  if (
    typeof totals.percentage !== 'number' ||
    !Number.isFinite(totals.percentage) ||
    totals.percentage < 0 ||
    totals.percentage > 100
  )
    failures.push(`${scopeName}: jscpd total percentage is invalid`);
  if (validCount(totals.clones) && totals.clones !== report.duplicates.length)
    failures.push(`${scopeName}: jscpd clone total does not match evidence`);

  for (const [index, clone] of report.duplicates.entries()) {
    if (
      !isRecord(clone) ||
      typeof clone.fragment !== 'string' ||
      clone.fragment.length === 0 ||
      !validCount(clone.lines) ||
      clone.lines === 0 ||
      typeof clone.firstFile?.name !== 'string' ||
      clone.firstFile.name.length === 0 ||
      typeof clone.secondFile?.name !== 'string' ||
      clone.secondFile.name.length === 0
    )
      failures.push(
        `${scopeName}: jscpd duplicate ${String(index + 1)} is malformed`,
      );
  }
  if (failures.length > 0) return failures;

  for (const [field, maximum] of Object.entries(scope.maximums)) {
    if (totals[field] > maximum) {
      failures.push(
        `${scopeName}: ${field} worsened from ${String(maximum)} to ${String(totals[field])}`,
      );
    }
  }

  const clones = actualClones(report);
  const observedClones = new Set();
  const observedReviews = new Set();
  for (const clone of clones) {
    const cloneIdentity = `${clone.pair}\u0000${clone.hash}`;
    if (observedClones.has(cloneIdentity)) {
      failures.push(`${scopeName}: duplicate clone evidence ${clone.hash}`);
      continue;
    }
    observedClones.add(cloneIdentity);
    const familyIndex = scope.families.findIndex(
      (family) =>
        pairKey(...family.files) === clone.pair &&
        family.clones.some((review) => review.hash === clone.hash),
    );
    if (familyIndex === -1) {
      failures.push(
        `${scopeName}: unexplained clone ${clone.pair.replace('\u0000', ' <-> ')} (${clone.hash})`,
      );
      continue;
    }
    const family = scope.families[familyIndex];
    const reviewIndex = family.clones.findIndex(
      (review) => review.hash === clone.hash,
    );
    const review = family.clones[reviewIndex];
    observedReviews.add(`${String(familyIndex)}:${String(reviewIndex)}`);
    if (!retainedClassifications.has(family.classification)) {
      failures.push(
        `${scopeName}: retained family ${String(familyIndex + 1)} has unsupported classification ${family.classification}`,
      );
    }
    if (family.reason.trim().length < 40) {
      failures.push(
        `${scopeName}: retained family ${String(familyIndex + 1)} needs a narrow justification`,
      );
    }
    if (clone.lines > review.maxLines) {
      failures.push(
        `${scopeName}: clone family ${String(familyIndex + 1)} review ${String(reviewIndex + 1)} grew from ${String(review.maxLines)} to ${String(clone.lines)} lines`,
      );
    }
  }

  scope.families.forEach((family, familyIndex) => {
    family.clones.forEach((_review, reviewIndex) => {
      if (
        !observedReviews.has(`${String(familyIndex)}:${String(reviewIndex)}`)
      ) {
        failures.push(
          `${scopeName}: retained family ${String(familyIndex + 1)} review ${String(reviewIndex + 1)} is stale; update the reviewed baseline`,
        );
      }
    });
  });
  return failures;
}

async function runJscpd(scope, outputDirectory) {
  const paths = globSync(scope.paths, { cwd: repositoryRoot }).sort();
  const timeoutMs = 120_000;
  const result = await runBoundedChildProcess(
    'pnpm',
    [
      'exec',
      'jscpd',
      ...paths,
      '--min-lines',
      String(scope.minLines),
      '--min-tokens',
      String(scope.minTokens),
      '--format',
      'typescript',
      '--reporters',
      'json',
      '--output',
      outputDirectory,
      '--ignore',
      scope.ignore,
    ],
    { cwd: repositoryRoot, timeoutMs },
  );
  if (
    result.status !== 0 ||
    result.timedOut ||
    result.spawnError !== undefined
  ) {
    throw new Error(
      `${describeBoundedChildFailure('jscpd', result, timeoutMs)}:\n${result.stdout}${result.stderr}`,
    );
  }
}

export async function main() {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  if (packageJson.devDependencies?.jscpd !== baseline.toolVersion) {
    throw new Error(
      `jscpd must remain pinned at ${baseline.toolVersion}; found ${String(packageJson.devDependencies?.jscpd)}`,
    );
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pertexo-jscpd-'));
  let primary = { error: undefined, failed: false };
  try {
    const failures = [];
    for (const [scopeName, scope] of Object.entries(baseline.scopes)) {
      const outputDirectory = join(temporaryDirectory, scopeName);
      await runJscpd(scope, outputDirectory);
      const report = JSON.parse(
        await readFile(join(outputDirectory, 'jscpd-report.json'), 'utf8'),
      );
      failures.push(...validateCloneReport(scopeName, scope, report));
      const totals = report.statistics.total;
      console.log(
        `${scopeName}: ${String(totals.clones)} groups, ${String(totals.duplicatedLines)} lines (${String(totals.percentage)}%)`,
      );
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  } catch (error) {
    primary = { error, failed: true };
    throw error;
  } finally {
    await preserveTemporaryDirectoryFailure(primary, () =>
      rm(temporaryDirectory, { force: true, recursive: true }),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
