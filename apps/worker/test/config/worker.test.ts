import { describe } from 'vitest';

import { registerPreservesClientDispatcherPoolSettingsOwn } from './worker/preserves-client-dispatcher-pool-settings-own.cases.js';
import { registerAppliesSafeDefaultsOptionalEnvironmentValues } from './worker/applies-safe-defaults-optional-environment-values.cases.js';
import { registerReachesDeployedKMSProtocolPolicyAfter } from './worker/reaches-deployed-kmsprotocol-policy-after.cases.js';
import { registerAcceptsScheduleOnTimeWindowAt } from './worker/accepts-schedule-on-time-window-at.cases.js';
import { registerDefaultsLocalScratchUnderWorkingDirectory } from './worker/defaults-local-scratch-under-working-directory.cases.js';
describe('parseWorkerConfig', () => {
  registerPreservesClientDispatcherPoolSettingsOwn();

  registerAppliesSafeDefaultsOptionalEnvironmentValues();

  registerReachesDeployedKMSProtocolPolicyAfter();

  registerAcceptsScheduleOnTimeWindowAt();
});
registerDefaultsLocalScratchUnderWorkingDirectory();
