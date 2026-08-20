import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { CONTRACT_ARTIFACTS } from '../src/artifacts.js';

const mode = process.argv[2];
if (mode !== '--check' && mode !== '--write') {
  throw new Error('Usage: generate-artifacts.ts --check|--write');
}

const artifactDirectory = new URL('../artifacts/', import.meta.url);

if (mode === '--write') {
  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all(
    CONTRACT_ARTIFACTS.map((artifact) =>
      writeFile(
        new URL(artifact.fileName, artifactDirectory),
        artifact.content,
        'utf8',
      ),
    ),
  );
} else {
  const drifted: string[] = [];
  for (const artifact of CONTRACT_ARTIFACTS) {
    let committed: string | undefined;
    try {
      committed = await readFile(
        new URL(artifact.fileName, artifactDirectory),
        'utf8',
      );
    } catch {
      committed = undefined;
    }
    if (committed !== artifact.content) drifted.push(artifact.fileName);
  }
  if (drifted.length > 0) {
    throw new Error(
      `Public contract artifact drift: ${drifted.join(', ')}. Run pnpm contracts:generate.`,
    );
  }
}
