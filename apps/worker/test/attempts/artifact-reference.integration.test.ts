import { describeIntegration } from './artifact-reference/fixture.js';
import { registerFinalizesVerifiesExpiresDirectUpload } from './artifact-reference/finalizes-verifies-expires-direct-upload.cases.js';
import { registerWritesConsumesIExactBytesThrough } from './artifact-reference/writes-consumes-iexact-bytes-through.cases.js';
describeIntegration('artifact direct upload', () => {
  registerFinalizesVerifiesExpiresDirectUpload();
});
describeIntegration('Phase 4 worker artifact output capability', () => {
  registerWritesConsumesIExactBytesThrough();
});
