import { describe } from 'vitest';

import { registerRejectsHTTPUnsafeArtifactMediaType } from './store/rejects-httpunsafe-artifact-media-type.cases.js';
import { registerFailsClosedSuccessfulPUTIsNot } from './store/fails-closed-successful-putis-not.cases.js';
import { registerPresignsAttachmentGETCanonicalWorkspaceArtifact } from './store/presigns-attachment-getcanonical-workspace-artifact.cases.js';
import { registerPreservesCallerCancellationThroughPostUpload } from './store/preserves-caller-cancellation-through-post-upload.cases.js';
import { registerDestroysS3ResponseBodyGetMetadata } from './store/destroys-s3-response-body-get-metadata.cases.js';
import { registerDeletesIdempotentlyReportsMissingDownload } from './store/deletes-idempotently-reports-missing-download.cases.js';
import { registerArtifactStoreRejectsDeleteAcknowledgementsS } from './store/artifact-store-rejects-delete-acknowledgements-s.cases.js';
describe('ArtifactStore', () => {
  registerRejectsHTTPUnsafeArtifactMediaType();

  registerFailsClosedSuccessfulPUTIsNot();

  registerPresignsAttachmentGETCanonicalWorkspaceArtifact();

  registerPreservesCallerCancellationThroughPostUpload();

  registerDestroysS3ResponseBodyGetMetadata();

  registerDeletesIdempotentlyReportsMissingDownload();

  registerArtifactStoreRejectsDeleteAcknowledgementsS();
});
