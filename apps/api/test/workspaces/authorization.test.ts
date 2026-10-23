import { describe } from 'vitest';

import { registerExposesCanonicalRolesStatusesFixedCapabilities } from './authorization/exposes-canonical-roles-statuses-fixed-capabilities.cases.js';
import { registerReusesMatchingGuardAuthorizationWithoutSecond } from './authorization/reuses-matching-guard-authorization-without-second.cases.js';
import { registerImmutableActorContextFreezesActorIdentity } from './authorization/immutable-actor-context-freezes-actor-identity.cases.js';
describe('workspace authorization policy', () => {
  registerExposesCanonicalRolesStatusesFixedCapabilities();

  registerReusesMatchingGuardAuthorizationWithoutSecond();
});
describe('immutable actor context', () => {
  registerImmutableActorContextFreezesActorIdentity();
});
