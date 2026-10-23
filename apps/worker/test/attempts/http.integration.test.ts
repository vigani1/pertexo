import { beforeAll, beforeEach } from 'vitest';

import { installHttpNodeAttemptFixture } from '../support/attempts/http-node-attempt.js';

import {
  describeIntegration,
  prepareHttpIntegrationTestTsFixture,
  resetHttpIntegrationTestTsFixture,
} from './http/fixture.js';
import { registerProviderRetryDelays } from './http/execution/provider-retry-delays.cases.js';
import { registerArtifactAttemptPersistence } from './http/execution/artifact-attempt-persistence.cases.js';
import { registerDispatchSecretFences } from './http/dispatch/dispatch-secret-fences.cases.js';
import { registerAcceptedHttpBindings } from './http/dispatch/accepted-http-bindings.cases.js';
import { registerDispatchEvidenceFailures } from './http/dispatch/dispatch-evidence-failures.cases.js';
import { registerUnsafeUnknownOutcomes } from './http/outcomes/unsafe-unknown-outcomes.cases.js';
import { registerEmailDispatchBindings } from './http/outcomes/email-dispatch-bindings.cases.js';
import { registerEmailRecoveryAmbiguity } from './http/outcomes/email-recovery-ambiguity.cases.js';
import { registerHeartbeatRecovery } from './http/outcomes/heartbeat-recovery.cases.js';
import { registerReplayProviderIdentities } from './http/outcomes/replay-provider-identities.cases.js';
installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);
describeIntegration('active HTTP node attempt', () => {
  registerProviderRetryDelays();

  registerArtifactAttemptPersistence();

  registerDispatchSecretFences();

  registerAcceptedHttpBindings();

  registerDispatchEvidenceFailures();

  registerUnsafeUnknownOutcomes();

  registerEmailDispatchBindings();

  registerEmailRecoveryAmbiguity();

  registerHeartbeatRecovery();

  registerReplayProviderIdentities();
});
