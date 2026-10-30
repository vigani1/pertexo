import { describe } from 'vitest';

import { registerAuthorizesBeforeTouchingDatabaseObjectStore } from './service/authorizes-before-touching-database-object-store.cases.js';
import { registerMapsStoreIntegrityFailureConflict } from './service/maps-store-integrity-failure-conflict.cases.js';
import { registerArtifactServiceConcealsSArtifactMetadata } from './service/artifact-service-conceals-sartifact-metadata.cases.js';
import { registerAcceptsExact10MiBCeilingRefuses } from './service/accepts-exact10-mi-bceiling-refuses.cases.js';
import { registerKeepsStorageFailureCause } from './service/keeps-storage-failure-cause.cases.js';
describe('ArtifactService', () => {
  registerAuthorizesBeforeTouchingDatabaseObjectStore();

  registerMapsStoreIntegrityFailureConflict();

  registerArtifactServiceConcealsSArtifactMetadata();

  registerKeepsStorageFailureCause();
});
registerAcceptsExact10MiBCeilingRefuses();
