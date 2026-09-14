#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  SOURCE_COVERAGE_COHORTS,
  sourceFilesInCollection,
} from './generate-coverage-evidence.mjs';
import { createCoverageProducerManifest } from './coverage-provenance.mjs';

async function readArtifact(rootDirectory, cohort) {
  const coverageFile = path.join(
    rootDirectory,
    'coverage',
    cohort,
    'coverage-final.json',
  );
  const resultFile = path.join(
    rootDirectory,
    'coverage',
    cohort,
    'test-results.json',
  );
  const [coverageBytes, resultBytes] = await Promise.all([
    readFile(coverageFile),
    readFile(resultFile),
  ]);
  return {
    coverageBytes,
    resultBytes,
    result: JSON.parse(resultBytes.toString('utf8')),
  };
}

async function main() {
  const rootDirectory = process.cwd();
  const sourcePaths = (
    await Promise.all(
      ['apps', 'packages'].map((collection) =>
        sourceFilesInCollection(rootDirectory, collection),
      ),
    )
  )
    .flat()
    .sort();
  const sources = new Map(
    await Promise.all(
      sourcePaths.map(async (file) => [
        path.relative(rootDirectory, file),
        await readFile(file),
      ]),
    ),
  );
  const artifacts = new Map(
    await Promise.all(
      SOURCE_COVERAGE_COHORTS.map(async (cohort) => [
        cohort,
        await readArtifact(rootDirectory, cohort),
      ]),
    ),
  );
  const sourceWitnessFile = path.join(
    rootDirectory,
    'coverage/coverage-source-witness.json',
  );
  const sourceWitnessBytes = await readFile(sourceWitnessFile);
  const sourceWitness = JSON.parse(sourceWitnessBytes.toString('utf8'));
  const riskReportBytes = await readFile(
    path.join(rootDirectory, 'coverage/risk-uncovered-branches.json'),
  );
  const packageJson = JSON.parse(
    await readFile(path.join(rootDirectory, 'package.json'), 'utf8'),
  );
  const manifest = createCoverageProducerManifest({
    artifacts,
    packageManager: packageJson.packageManager,
    riskReport: JSON.parse(riskReportBytes.toString('utf8')),
    riskReportBytes,
    sourceWitness,
    sources,
  });
  await Promise.all([
    ...sourcePaths.map(async (file) => {
      const expected = sources.get(path.relative(rootDirectory, file));
      if (!(await readFile(file)).equals(expected))
        throw new Error(`Coverage source changed while recording: ${file}`);
    }),
    ...[...artifacts.entries()].flatMap(([cohort, artifact]) => [
      readFile(
        path.join(rootDirectory, 'coverage', cohort, 'coverage-final.json'),
      ).then((current) => {
        if (!current.equals(artifact.coverageBytes))
          throw new Error(
            `Coverage artifact changed while recording: ${cohort}`,
          );
      }),
      readFile(
        path.join(rootDirectory, 'coverage', cohort, 'test-results.json'),
      ).then((current) => {
        if (!current.equals(artifact.resultBytes))
          throw new Error(`Coverage result changed while recording: ${cohort}`);
      }),
    ]),
    readFile(
      path.join(rootDirectory, 'coverage/risk-uncovered-branches.json'),
    ).then((current) => {
      if (!current.equals(riskReportBytes))
        throw new Error('Risk report changed while recording coverage');
    }),
    readFile(sourceWitnessFile).then((current) => {
      if (!current.equals(sourceWitnessBytes))
        throw new Error('Coverage source witness changed while recording');
    }),
  ]);
  await writeFile(
    path.join(rootDirectory, 'coverage/coverage-producer-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `Bound ${String(manifest.cohorts.length)} coverage cohorts to ${manifest.candidateFingerprint}.\n`,
  );
}

await main();
