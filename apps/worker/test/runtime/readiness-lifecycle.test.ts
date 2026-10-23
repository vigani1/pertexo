import { afterEach, beforeEach, describe } from 'vitest';

import {
  resetAppsWorkerTestRuntimeReadinessLifecycleWorkerReadinessLifecycleFixture,
  cleanAppsWorkerTestRuntimeReadinessLifecycleWorkerReadinessLifecycleFixture,
} from './readiness-lifecycle/fixture.js';
import { registerDoesNotRecreateReadinessAfterShutdown } from './readiness-lifecycle/does-not-recreate-readiness-after-shutdown.cases.js';
import { registerCorrectsReadyWriteCompletesAfterBounded } from './readiness-lifecycle/corrects-ready-write-completes-after-bounded.cases.js';
describe('worker readiness lifecycle', () => {
  beforeEach(
    resetAppsWorkerTestRuntimeReadinessLifecycleWorkerReadinessLifecycleFixture,
  );

  afterEach(
    cleanAppsWorkerTestRuntimeReadinessLifecycleWorkerReadinessLifecycleFixture,
  );
  registerDoesNotRecreateReadinessAfterShutdown();

  registerCorrectsReadyWriteCompletesAfterBounded();
});
