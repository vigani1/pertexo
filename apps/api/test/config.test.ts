import { describe } from 'vitest';

import { registerPreservesConfiguredClientPoolSettingsFrozen } from './config/preserves-configured-client-pool-settings-frozen.cases.js';
import { registerParsesValidEnvironmentValuesIntoTyped } from './config/parses-valid-environment-values-into-typed.cases.js';
import { registerRejectsSStandaloneBetterAuth } from './config/rejects-sstandalone-better-auth.cases.js';
import { registerSecuresCookiesOnHTTPSOrigin } from './config/secures-cookies-on-httpsorigin.cases.js';
describe('parseApiConfig', () => {
  registerPreservesConfiguredClientPoolSettingsFrozen();

  registerParsesValidEnvironmentValuesIntoTyped();
});
describe('parseApiConfig identity boundary', () => {
  registerRejectsSStandaloneBetterAuth();

  registerSecuresCookiesOnHTTPSOrigin();
});
