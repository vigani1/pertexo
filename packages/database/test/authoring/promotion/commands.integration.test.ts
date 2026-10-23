import { afterAll, beforeAll } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './commands/fixture.js';
import { registerConfiguresTargetRevisionChecksPermits } from './commands/configures-target-revision-checks-permits.cases.js';
import { registerRetainsCanvasDocumentationPromotedDraft } from './commands/retains-canvas-documentation-promoted-draft.cases.js';
import { registerQualifies20WorkflowBatchWithin } from './commands/qualifies20-workflow-batch-within.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
registerConfiguresTargetRevisionChecksPermits();
registerRetainsCanvasDocumentationPromotedDraft();
registerQualifies20WorkflowBatchWithin();
