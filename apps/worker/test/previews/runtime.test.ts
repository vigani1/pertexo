import { afterEach, describe } from 'vitest';

import { cleanAppsWorkerTestPreviewsRuntimeTestRuntimeTestTsFixture } from './runtime/fixture.js';
import { registerRejectsArtifactBackedPreviewInputBefore } from './runtime/rejects-artifact-backed-preview-input-before.cases.js';
import { registerExecutesActiveSlackActionThroughProduction } from './runtime/executes-active-slack-action-through-production.cases.js';
import { registerPreservesCancellationResolvingPreviewInputMappings } from './runtime/preserves-cancellation-resolving-preview-input-mappings.cases.js';
import { registerPlatformPreviewNodeInvokerClassifiesExecutorFailure } from './runtime/platform-preview-node-invoker-classifies-executor-failure.cases.js';
afterEach(cleanAppsWorkerTestPreviewsRuntimeTestRuntimeTestTsFixture);
describe('platform preview node invoker', () => {
  registerRejectsArtifactBackedPreviewInputBefore();

  registerExecutesActiveSlackActionThroughProduction();

  registerPreservesCancellationResolvingPreviewInputMappings();

  registerPlatformPreviewNodeInvokerClassifiesExecutorFailure();
});
