import { describe } from 'vitest';

import { registerUsesPinnedOutputWithoutEvaluatingMappings } from './use-case/uses-pinned-output-without-evaluating-mappings.cases.js';
import { registerPreservesUnknownDraftReadFailureBy } from './use-case/preserves-unknown-draft-read-failure-by.cases.js';
import { registerRequiresIdempotencyBeforeAcceptingAcknowledgedExecution } from './use-case/requires-idempotency-before-accepting-acknowledged-execution.cases.js';
import { registerAcceptsOneIdentifierDurablePreview } from './use-case/accepts-one-identifier-durable-preview.cases.js';
import { registerDeniesBeforeReadingCallerLacksWorkflow } from './use-case/denies-before-reading-caller-lacks-workflow.cases.js';
describe('node test application use case', () => {
  registerUsesPinnedOutputWithoutEvaluatingMappings();

  registerPreservesUnknownDraftReadFailureBy();

  registerRequiresIdempotencyBeforeAcceptingAcknowledgedExecution();

  registerAcceptsOneIdentifierDurablePreview();
});
describe('preview status application use case', () => {
  registerDeniesBeforeReadingCallerLacksWorkflow();
});
