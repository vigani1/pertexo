import { expect, it, vi } from 'vitest';

import { createWorkspaceInboxRuntime } from '../../src/notifications/inbox.runtime.js';

// Kept off the real path: a PostgreSQL pool and a Redis client close without
// failing, so the integration test cannot make both fail at shutdown.
it('reports every resource that fails to close', async () => {
  const runtime = createWorkspaceInboxRuntime(
    {
      checkReadiness: vi.fn(),
      foldPending: vi.fn(),
      close: () => Promise.reject(new Error('store')),
    },
    {
      publish: vi.fn(),
      close: () => Promise.reject(new Error('publisher')),
    },
    { foldBatchSize: 100, foldPollMillis: 1_000 },
    { cycleFailed: vi.fn(), hintFailed: vi.fn() },
  );

  const failure: unknown = await runtime
    .close()
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    new Error('store'),
    new Error('publisher'),
  ]);
});
