import { expect, it } from 'vitest';

import { loadBuiltEntry } from '../support/built-entry.js';

it('loads @pertexo/core/artifacts as a built package with what its callers use', async () => {
  await expect(loadBuiltEntry('@pertexo/core/artifacts')).resolves.toEqual([
    'ARTIFACT_UPLOAD_PENDING_MS',
    'ARTIFACT_UPLOAD_PURPOSE',
    'ArtifactMetadataNotFoundError',
    'ArtifactQuotaExceededError',
    'ArtifactUploadConflictError',
    'ArtifactUploadIdempotencyConflictError',
    'ArtifactUploadNotFoundError',
    'FormUploadLimitError',
    'artifactStorageKey',
    'createArtifactUploadStore',
    'createFormUploadStore',
    'createPendingArtifact',
    'createPendingPreviewArtifact',
    'finalizeArtifactUpload',
    'readArtifactCapacity',
    'readExecutionStorageCapacity',
    'requireNodeArtifactReference',
  ]);
}, 60_000);
