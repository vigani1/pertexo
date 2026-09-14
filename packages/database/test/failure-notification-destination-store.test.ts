import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const withTenantScopedClient = vi.hoisted(() => vi.fn());

vi.mock('../src/tenant-access/workspace.js', () => ({
  withTenantScopedClient,
}));

import { createFailureNotificationDestinationStore } from '../src/execution/failure-notification-destination-store.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const intentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('failure notification destination attempt validation', () => {
  beforeEach(() => {
    withTenantScopedClient.mockReset();
  });

  it.each([
    -1,
    0,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    11,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects load attempt %s before checkout', async (attemptNumber) => {
    const store = createFailureNotificationDestinationStore({} as Pool);
    await expect(
      store.loadDestination({
        attemptNumber,
        intentId,
        signal: new AbortController().signal,
        workerId: 'notification-worker',
        workspaceId,
      }),
    ).rejects.toThrow('Invalid delivery attempt number');
    expect(withTenantScopedClient).not.toHaveBeenCalled();
  });

  it.each([
    -1,
    0,
    1.5,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    11,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects fence attempt %s before checkout', async (attemptNumber) => {
    const store = createFailureNotificationDestinationStore({} as Pool);
    await expect(
      store.fenceDispatch({ attemptNumber, intentId, workspaceId }),
    ).rejects.toThrow('Invalid delivery attempt number');
    expect(withTenantScopedClient).not.toHaveBeenCalled();
  });

  it.each([1, 10])(
    'accepts load attempt boundary %s at the transaction seam',
    async (attemptNumber) => {
      withTenantScopedClient.mockResolvedValueOnce(undefined);
      const store = createFailureNotificationDestinationStore({} as Pool);
      await expect(
        store.loadDestination({
          attemptNumber,
          intentId,
          signal: new AbortController().signal,
          workerId: 'notification-worker',
          workspaceId,
        }),
      ).resolves.toBeUndefined();
      expect(withTenantScopedClient).toHaveBeenCalledOnce();
    },
  );

  it.each([1, 10])(
    'accepts fence attempt boundary %s at the transaction seam',
    async (attemptNumber) => {
      withTenantScopedClient.mockResolvedValueOnce(undefined);
      const store = createFailureNotificationDestinationStore({} as Pool);
      await expect(
        store.fenceDispatch({ attemptNumber, intentId, workspaceId }),
      ).resolves.toBeUndefined();
      expect(withTenantScopedClient).toHaveBeenCalledOnce();
    },
  );
});
