import { createHash } from 'node:crypto';
import console from 'node:console';
import { globSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
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

export function validateCloneReport(scopeName, scope, report) {
  const failures = [];
  const totals = report.statistics?.total;
  if (totals === undefined) return [`${scopeName}: jscpd totals are missing`];

  for (const [field, maximum] of Object.entries(scope.maximums)) {
    if (totals[field] > maximum) {
      failures.push(
        `${scopeName}: ${field} worsened from ${String(maximum)} to ${String(totals[field])}`,
      );
    }
  }

  const clones = actualClones(report);
  const observedReviews = new Set();
  for (const clone of clones) {
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

function runJscpd(scope, outputDirectory) {
  const paths = globSync(scope.paths, { cwd: repositoryRoot }).sort();
  const result = spawnSync(
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
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `jscpd failed (${String(result.status)}):\n${result.stdout}${result.stderr}`,
    );
  }
}

export async function main() {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (packageJson.devDependencies?.jscpd !== baseline.toolVersion) {
    throw new Error(
      `jscpd must remain pinned at ${baseline.toolVersion}; found ${String(packageJson.devDependencies?.jscpd)}`,
    );
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pertexo-jscpd-'));
  try {
    const failures = [];
    for (const [scopeName, scope] of Object.entries(baseline.scopes)) {
      const outputDirectory = join(temporaryDirectory, scopeName);
      runJscpd(scope, outputDirectory);
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
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
