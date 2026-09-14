#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  coverageSourceFingerprint,
  createCoverageSourceWitness,
} from './coverage-provenance.mjs';
import { sourceFilesInCollection } from './generate-coverage-evidence.mjs';

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
  const witness = createCoverageSourceWitness({ sources });
  const currentSources = new Map(
    await Promise.all(
      sourcePaths.map(async (file) => [
        path.relative(rootDirectory, file),
        await readFile(file),
      ]),
    ),
  );
  if (coverageSourceFingerprint(currentSources) !== witness.sourceFingerprint)
    throw new Error('Coverage source changed while recording its witness');
  await mkdir(path.join(rootDirectory, 'coverage'), { recursive: true });
  await writeFile(
    path.join(rootDirectory, 'coverage/coverage-source-witness.json'),
    `${JSON.stringify(witness, null, 2)}\n`,
  );
  process.stdout.write(
    `Recorded a pre-test witness for ${String(witness.sourceFiles.length)} source files.\n`,
  );
}

await main();
