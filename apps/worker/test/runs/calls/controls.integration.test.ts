import { describe } from 'vitest';
import { fixture } from './fixtures.js';
import { createCallControlsFixture } from './controls/fixture.js';
import { registerReturnsValidatedChildOutputThroughOrdinaryRun } from './controls/output.cases.js';
import { registerNarrowsRecordedChildDeadlineFailsRequiredCall } from './controls/deadline-cancellation.cases.js';

const describeIntegration = fixture.enabled ? describe : describe.skip;

describeIntegration('Workflow Call controls and retained public reads', () => {
  const caseFixture = createCallControlsFixture();
  registerReturnsValidatedChildOutputThroughOrdinaryRun(caseFixture);
  registerNarrowsRecordedChildDeadlineFailsRequiredCall(caseFixture);
});
