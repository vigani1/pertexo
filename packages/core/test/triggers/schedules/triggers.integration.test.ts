import { afterAll, beforeAll, describe } from 'vitest';

import { schedule, beforeAllFixture1 } from './triggers/fixture.js';
import { registerRequestsWorkerAdmitsReplayImmutable } from './triggers/requests-worker-admits-replay-immutable.cases.js';
import { registerDryRunsExactlyReplaysFresh } from './triggers/dry-runs-exactly-replays-fresh.cases.js';
import { registerMarksClaimedPermanentScanFailure } from './triggers/marks-claimed-permanent-scan-failure.cases.js';
beforeAll(beforeAllFixture1, 60_000);
afterAll(schedule.close);
describe('schedule trigger PostgreSQL slice', () => {
  registerRequestsWorkerAdmitsReplayImmutable();

  registerDryRunsExactlyReplaysFresh();

  registerMarksClaimedPermanentScanFailure();
});
