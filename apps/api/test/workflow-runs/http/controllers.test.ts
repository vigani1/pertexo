import { describe } from 'vitest';

import { registerStrictlyParsesForwardsBoundedRunHistory } from './controllers/strictly-parses-forwards-bounded-run-history.cases.js';
import { registerParsesExplicitReplayRequestForwardsSource } from './controllers/parses-explicit-replay-request-forwards-source.cases.js';
import { registerReleasesRequestDrainOwnershipSSEResponse } from './controllers/releases-request-drain-ownership-sseresponse.cases.js';
describe('workflow runs controller public seam', () => {
  registerStrictlyParsesForwardsBoundedRunHistory();

  registerParsesExplicitReplayRequestForwardsSource();

  registerReleasesRequestDrainOwnershipSSEResponse();
});
