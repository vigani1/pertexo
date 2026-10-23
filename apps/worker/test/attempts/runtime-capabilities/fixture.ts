import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createWorkerNodeRuntimeCapabilities as createRuntimeCapabilities } from '../../../src/testing.js';

export const workspaceId = '11111111-1111-4111-8111-111111111111';

export const connectionId = '22222222-2222-4222-8222-222222222222';

export const secretVersionId = '33333333-3333-4333-8333-333333333333';

export const artifactId = '44444444-4444-4444-8444-444444444444';

export const previewRunId = '99999999-9999-4999-8999-999999999999';

export const context = {
  workspaceId,
  runId: '55555555-5555-4555-8555-555555555555',
  nodeRunId: '66666666-6666-4666-8666-666666666666',
  attemptId: '77777777-7777-4777-8777-777777777777',
  attemptNumber: 1,
  nodeId: 'http-node',
  invocationKey: 'http-invocation',
  workerId: 'worker-1',
  fenceToken: 1,
} as const;

export const databaseConfig = {
  connectionString: 'postgresql://worker:password@localhost/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  ownerRole: 'pertexo_owner',
} as const;

export const temporaryDirectories: string[] = [];

export async function createOwnedCapabilities(
  options: Parameters<typeof createRuntimeCapabilities>[0],
  dependencies: NonNullable<
    Parameters<typeof createRuntimeCapabilities>[1]
  > = {},
) {
  let spoolDirectory = dependencies.spoolDirectory;
  if (spoolDirectory === undefined) {
    spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
  }
  return createRuntimeCapabilities(options, {
    ...dependencies,
    spoolDirectory,
  });
}

export async function cleanRuntimeCapabilitiesTestTsFixture() {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}
