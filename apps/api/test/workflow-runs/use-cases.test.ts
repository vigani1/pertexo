import { describe } from 'vitest';

import { registerPassesExactRunValuePairThrough } from './use-cases/passes-exact-run-value-pair-through.cases.js';
import { registerReusesGuardAuthorizationWithoutRepeatingAccess } from './use-cases/reuses-guard-authorization-without-repeating-access.cases.js';
import { registerKeepsStartReplayCapabilitiesDistinct } from './use-cases/keeps-start-replay-capabilities-distinct.cases.js';
import { registerAuthorizesCancellationForwardsCanonicalActorRequest } from './use-cases/authorizes-cancellation-forwards-canonical-actor-request.cases.js';
import { registerDoesNotAcquireProducerStartAuthorization } from './use-cases/does-not-acquire-producer-start-authorization.cases.js';
import { registerStopsBeforeLaterFrameAfterS } from './use-cases/stops-before-later-frame-after-s.cases.js';
describe('workflow run application seams', () => {
  registerPassesExactRunValuePairThrough();

  registerReusesGuardAuthorizationWithoutRepeatingAccess();

  registerKeepsStartReplayCapabilitiesDistinct();

  registerAuthorizesCancellationForwardsCanonicalActorRequest();

  registerDoesNotAcquireProducerStartAuthorization();

  registerStopsBeforeLaterFrameAfterS();
});
