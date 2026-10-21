import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function createTestArtifactScratch() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-worker-scratch-'),
  );
  return {
    directory,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
