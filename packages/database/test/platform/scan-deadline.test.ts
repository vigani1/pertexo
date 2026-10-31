import { expect, it } from 'vitest';

import { withDatabaseDeadlineBudget } from '../../src/platform/pool/policy.js';
import { STALLED_WORK_POOL_ROLE } from '../../src/runs/stalled/repository.js';

// What the worker's health check allows a scan before it ends the worker.
const HEALTH_CHECK_LIMIT_MS = 300_000;

// The marker only moves when a scan settles, so a scan a hung Postgres could hold
// past the check would turn an outage into a restart.
it('gives up on a hung Postgres before the health check ends the worker', () => {
  const { query_timeout: limit } = withDatabaseDeadlineBudget(
    {},
    STALLED_WORK_POOL_ROLE,
  );
  expect(limit).toBeLessThan(HEALTH_CHECK_LIMIT_MS);
});
