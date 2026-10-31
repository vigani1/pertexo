import { expect, it } from 'vitest';

import { withDatabaseDeadlineBudget } from '../../src/platform/pool/policy.js';

// What the worker's health check allows a scan before it ends the worker.
const HEALTH_CHECK_LIMIT_MS = 300_000;

// reliability review: a hung Postgres holds a scan for 305 s, past the 300 s check.
// The marker only moves when a scan settles, so an outage restarts the worker.
it.fails(
  'gives up on a hung Postgres before the health check ends the worker',
  () => {
    const { query_timeout: limit } = withDatabaseDeadlineBudget(
      {},
      'maintenance',
    );
    expect(limit).toBeLessThan(HEALTH_CHECK_LIMIT_MS);
  },
);
