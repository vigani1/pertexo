import { describe } from 'vitest';

import { registerEnforcesV4V7ArtifactReferences } from './commit-output/enforces-v4-v7-artifact-references.cases.js';
import { registerAtomicallyCommitsExactEventsAll } from './commit-output/atomically-commits-exact-events-all.cases.js';
import { registerCommitsPersistedRetryFactsAdmits } from './commit-output/commits-persisted-retry-facts-admits.cases.js';
import { registerCommitsPersistedWaitFactUsing } from './commit-output/commits-persisted-wait-fact-using.cases.js';
describe('Coordinator output commit invariants', () => {
  registerEnforcesV4V7ArtifactReferences();

  registerAtomicallyCommitsExactEventsAll();

  registerCommitsPersistedRetryFactsAdmits();

  registerCommitsPersistedWaitFactUsing();
});
