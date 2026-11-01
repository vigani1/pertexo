import { ArtifactScratchSpace } from '../../artifacts/scratch/space.js';
import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';

import { createArtifactStore } from '@pertexo/artifact-store';

import {
  createPendingArtifact,
  createPendingPreviewArtifact,
  finalizeArtifactUpload,
  requireNodeArtifactReference,
} from '@pertexo/core/runs';
import {
  createWorkspaceDatabase,
  type WorkspaceDatabase,
} from '@pertexo/database/platform';

import {
  createNodeArtifactRuntimeFactory,
  type WorkerArtifactPersistence,
} from '../../artifacts/runtime.js';
import type { CapabilityAssembly } from './contract.js';
import { assertCapabilityRuntimeOpen } from './lifecycle.js';

function artifactPersistence(
  database: WorkspaceDatabase,
): WorkerArtifactPersistence {
  return Object.freeze({
    requireReadable: async (
      input: Parameters<
        NonNullable<WorkerArtifactPersistence['requireReadable']>
      >[0],
    ) => {
      await database.withWorkspace(
        input.workspaceId,
        (transaction) =>
          requireNodeArtifactReference(
            transaction,
            input.reference,
            input.previewRunId,
          ),
        { signal: input.signal },
      );
    },
    createPending: async (
      input: Parameters<WorkerArtifactPersistence['createPending']>[0],
    ): Promise<void> => {
      await database.withWorkspace(
        input.workspaceId,
        (transaction) =>
          input.previewRunId === undefined
            ? createPendingArtifact(transaction, {
                artifactId: input.artifactId,
                byteLength: input.byteLength,
                mediaType: input.mediaType,
                sha256: input.sha256,
                storageKey: input.storageKey,
                expiresAt: input.expiresAt,
                purpose: input.purpose,
              })
            : createPendingPreviewArtifact(transaction, {
                artifactId: input.artifactId,
                byteLength: input.byteLength,
                mediaType: input.mediaType,
                sha256: input.sha256,
                storageKey: input.storageKey,
                expiresAt: input.expiresAt,
                purpose: input.purpose,
                previewRunId: input.previewRunId,
              }),
        { signal: input.signal },
      );
    },
    finalize: async (
      input: Parameters<WorkerArtifactPersistence['finalize']>[0],
    ): Promise<void> => {
      await database.withWorkspace(
        input.workspaceId,
        (transaction) =>
          finalizeArtifactUpload(transaction, {
            artifactId: input.artifactId,
            workspaceId: input.workspaceId,
            byteLength: input.byteLength,
            mediaType: input.mediaType,
            sha256: input.sha256,
            storageKey: input.storageKey,
          }),
        { signal: input.signal },
      );
    },
  });
}

export async function prepareArtifactCapability(
  state: CapabilityAssembly,
): Promise<void> {
  const persistence =
    state.dependencies.artifactPersistence ??
    artifactPersistence(
      (state.resources.ownedArtifactDatabase = createWorkspaceDatabase(
        state.options.database,
        state.dependencies.databaseRuntime === undefined
          ? {}
          : { runtime: state.dependencies.databaseRuntime },
      )),
    );
  const store =
    state.dependencies.artifactStore ??
    (state.options.artifactStore === undefined
      ? undefined
      : (state.resources.ownedArtifactStore = createArtifactStore(
          state.options.artifactStore,
        )));
  if (store === undefined)
    throw new Error('Worker artifact capability is incomplete');
  const reachability = store;
  const checkReachable = reachability.checkReadiness;
  if (checkReachable !== undefined)
    state.checkObjectStore = () => checkReachable.call(reachability);
  const directory =
    state.dependencies.spoolDirectory ?? state.options.artifactScratchDirectory;
  if (directory === undefined)
    throw new Error(
      'Configure ARTIFACT_SCRATCH_DIRECTORY as a private disk-backed directory for this worker.',
    );
  const scratch = await ArtifactScratchSpace.create(
    directory,
    state.dependencies.artifactSpoolOperations,
  );
  state.checkArtifactReadiness = () => {
    scratch.checkReadiness();
  };
  state.factories.artifacts = createNodeArtifactRuntimeFactory({
    assertOpen: () => {
      assertCapabilityRuntimeOpen(state.lifecycle);
    },
    scratch,
    maximumBytes: Math.min(
      FILE_PAGE_LIMITS.fileBytes,
      state.options.artifactStore?.maxObjectBytes ?? FILE_PAGE_LIMITS.fileBytes,
    ),
    persistence,
    store,
    retentionMillis: state.retentionMillis,
    ...(state.dependencies.artifactId === undefined
      ? {}
      : { artifactId: state.dependencies.artifactId }),
    ...(state.dependencies.now === undefined
      ? {}
      : { now: state.dependencies.now }),
  });
}
