import { afterAll, beforeAll } from 'vitest';

import { assertIntegrationGateConfigured } from '../support/integration-gate.js';
import { artifactTransferIntegrationRequested } from './transfer.support.js';
import {
  integrationDescribe,
  prepareAuthenticatedArtifactTransferHTTPFixture,
  closeAuthenticatedArtifactTransferHTTPFixture,
} from './transfer/fixture.js';
import { registerRejectsNameBeforePersistenceStorage } from './transfer/rejects-name-before-persistence-storage.cases.js';
import { registerClaimsOneExactConcurrentUploadEnforces } from './transfer/claims-one-exact-concurrent-upload-enforces.cases.js';
import { registerRejectsImmutableSignedPUTMetadataName } from './transfer/rejects-immutable-signed-putmetadata-name.cases.js';
import { registerDoesNotReleasePendingChargeOn } from './transfer/does-not-release-pending-charge-on.cases.js';
if (artifactTransferIntegrationRequested) {
  assertIntegrationGateConfigured({
    name: 'artifact transfer HTTP and object-store integration',
    requested: true,
    required: {
      DATABASE_URL: process.env.DATABASE_URL,
      ARTIFACT_STORE_ACCESS_KEY_ID: process.env.ARTIFACT_STORE_ACCESS_KEY_ID,
      ARTIFACT_STORE_BUCKET: process.env.ARTIFACT_STORE_BUCKET,
      ARTIFACT_STORE_ENDPOINT: process.env.ARTIFACT_STORE_ENDPOINT,
      ARTIFACT_STORE_REGION: process.env.ARTIFACT_STORE_REGION,
      ARTIFACT_STORE_SECRET_ACCESS_KEY:
        process.env.ARTIFACT_STORE_SECRET_ACCESS_KEY,
    },
  });
}
integrationDescribe('authenticated artifact transfer HTTP', () => {
  beforeAll(prepareAuthenticatedArtifactTransferHTTPFixture);

  afterAll(closeAuthenticatedArtifactTransferHTTPFixture);
  registerRejectsNameBeforePersistenceStorage();

  registerClaimsOneExactConcurrentUploadEnforces();

  registerRejectsImmutableSignedPUTMetadataName();

  registerDoesNotReleasePendingChargeOn();
});
