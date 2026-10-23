import { afterEach, describe } from 'vitest';

import { cleanBetterAuthFastifyBridgeFixture } from './better-auth-fastify/fixture.js';
import { registerPreservesJSONBodiesOriginChecksEvery } from './better-auth-fastify/preserves-jsonbodies-origin-checks-every.cases.js';
import { registerKeepsNativeBrowserResponsesTokenFree } from './better-auth-fastify/keeps-native-browser-responses-token-free.cases.js';
import { registerServesConfiguredCapabilitiesBootstrapsApplicationCSRF } from './better-auth-fastify/serves-configured-capabilities-bootstraps-application-csrf.cases.js';
describe('Better Auth Fastify bridge', () => {
  afterEach(cleanBetterAuthFastifyBridgeFixture);
  registerPreservesJSONBodiesOriginChecksEvery();

  registerKeepsNativeBrowserResponsesTokenFree();

  registerServesConfiguredCapabilitiesBootstrapsApplicationCSRF();
});
