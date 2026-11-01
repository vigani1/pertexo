import { beforeEach, describe } from 'vitest';

import { beforeEachFixture1 } from './retention-artifacts/fixture.js';
import { registerRetainsEveryOrdinaryPageNested } from './retention-artifacts/retains-every-ordinary-page-nested.cases.js';
import { registerKeepsExpiredPendingUploadDeleting } from './retention-artifacts/keeps-expired-pending-upload-deleting.cases.js';
import { registerRetainsReferencedArtifactsDeletesUnreferenced } from './retention-artifacts/retains-referenced-artifacts-deletes-unreferenced.cases.js';
import { registerFailsLateUploadFinalizationOnce } from './retention-artifacts/fails-late-upload-finalization-once.cases.js';
import { registerKeepsArtifactStillReferenced } from './retention-artifacts/keeps-artifact-still-referenced.cases.js';
import { registerDeletesAbandonedFormUpload } from './retention-artifacts/deletes-abandoned-form-upload.cases.js';
beforeEach(beforeEachFixture1);
describe('retention artifact reclamation', () => {
  registerRetainsEveryOrdinaryPageNested();

  registerKeepsExpiredPendingUploadDeleting();

  registerRetainsReferencedArtifactsDeletesUnreferenced();

  registerKeepsArtifactStillReferenced();

  registerFailsLateUploadFinalizationOnce();

  registerDeletesAbandonedFormUpload();
});
