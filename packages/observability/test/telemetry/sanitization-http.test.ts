import { beforeAll, describe } from 'vitest';

import { prepareConfiguredHTTPUndiciExportScenariosFixture } from './sanitization-http/fixture.js';
import { registerSanitizesExceptionsStatusMessagesThroughConfigured } from './sanitization-http/sanitizes-exceptions-status-messages-through-configured.cases.js';
import { registerRetainsSafeServerNodeHTTPClient } from './sanitization-http/retains-safe-server-node-httpclient.cases.js';
describe('HTTP telemetry URL privacy', () => {
  registerSanitizesExceptionsStatusMessagesThroughConfigured();

  describe('configured HTTP and Undici export scenarios', () => {
    beforeAll(prepareConfiguredHTTPUndiciExportScenariosFixture);
    registerRetainsSafeServerNodeHTTPClient();
  });
});
