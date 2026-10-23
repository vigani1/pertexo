import { afterEach, describe } from 'vitest';

import { cleanRuntimeCapabilitiesTestTsFixture } from './runtime-capabilities/fixture.js';
import { registerWebhookResponseBindings } from './runtime-capabilities/capabilities/webhook-response-bindings.cases.js';
import { registerCapabilityShutdownFailures } from './runtime-capabilities/capabilities/capability-shutdown-failures.cases.js';
import { registerAdmissionCancellation } from './runtime-capabilities/capabilities/admission-cancellation.cases.js';
import { registerConnectionSecretCleanup } from './runtime-capabilities/capabilities/connection-secret-cleanup.cases.js';
import { registerHttpFailureClassification } from './runtime-capabilities/capabilities/http-failure-classification.cases.js';
import { registerVerifiedArtifactReads } from './runtime-capabilities/artifacts/verified-artifact-reads.cases.js';
import { registerArtifactSourceCleanup } from './runtime-capabilities/artifacts/artifact-source-cleanup.cases.js';
import { registerSpoolCancellation } from './runtime-capabilities/artifacts/spool-cancellation.cases.js';
import { registerScratchCleanupFailures } from './runtime-capabilities/artifacts/scratch-cleanup-failures.cases.js';
import { registerGeneratedArtifactIdentities } from './runtime-capabilities/artifacts/generated-artifact-identities.cases.js';
import { registerConcurrentScratchCleanup } from './runtime-capabilities/artifacts/concurrent-scratch-cleanup.cases.js';
afterEach(cleanRuntimeCapabilitiesTestTsFixture);
describe('worker node runtime capabilities', () => {
  registerWebhookResponseBindings();

  registerCapabilityShutdownFailures();

  registerAdmissionCancellation();

  registerConnectionSecretCleanup();

  registerHttpFailureClassification();

  registerVerifiedArtifactReads();

  registerArtifactSourceCleanup();

  registerSpoolCancellation();

  registerScratchCleanupFailures();

  registerGeneratedArtifactIdentities();
});
registerConcurrentScratchCleanup();
