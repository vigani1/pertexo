import { beforeAll, afterAll, describe } from 'vitest';

import { fixture } from '../calls/fixtures.js';
import { prepareApprovalThroughRealWorkersDurableTasks } from './execution/fixture.js';
import { registerContinuesSPathOnceAfterWorker } from './execution/continues-spath-once-after-worker.cases.js';
import { registerClosesPendingTaskCancellationWinsRejects } from './execution/closes-pending-task-cancellation-wins-rejects.cases.js';
import { registerPausesUnstartedSiblingCallDeadlineAnother } from './execution/pauses-unstarted-sibling-call-deadline-another.cases.js';
import { registerContinuesTimedOutPath } from './execution/continues-timed-out-path.cases.js';
describe.runIf(fixture.enabled)(
  'Approval through real workers, durable tasks and transport',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    beforeAll(prepareApprovalThroughRealWorkersDurableTasks);
    registerContinuesSPathOnceAfterWorker();

    registerClosesPendingTaskCancellationWinsRejects();

    registerPausesUnstartedSiblingCallDeadlineAnother();

    registerContinuesTimedOutPath();
  },
);
