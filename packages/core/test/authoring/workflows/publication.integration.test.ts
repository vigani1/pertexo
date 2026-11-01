import { describe } from 'vitest';

import { registerRejectsMalformedNewAdmissionWithout } from './publication/rejects-malformed-new-admission-without.cases.js';
import { registerUsesCanonicalExecutableIdentityRather } from './publication/uses-canonical-executable-identity-rather.cases.js';
import { registerAtomicallyPersistsInjectedExecutablePublication } from './publication/atomically-persists-injected-executable-publication.cases.js';
import { registerTransactionallyRebuildsDerivedIntegrationUsage } from './publication/transactionally-rebuilds-derived-integration-usage.cases.js';
import { registerNamesStepConnectionIsUnknown } from './publication/names-step-connection-is-unknown.cases.js';
describe('workflow publication projections', () => {
  registerRejectsMalformedNewAdmissionWithout();

  registerUsesCanonicalExecutableIdentityRather();

  registerAtomicallyPersistsInjectedExecutablePublication();

  registerTransactionallyRebuildsDerivedIntegrationUsage();

  registerNamesStepConnectionIsUnknown();
});
