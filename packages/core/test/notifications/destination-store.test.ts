import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const withTenantScopedClient = vi.hoisted(() => vi.fn());

vi.mock('../../../database/dist/tenant-access/transactions.js', () => ({
  withTenantScopedClient,
}));

import {
  fenceDispatch,
  loadDestination,
} from '../../src/notifications/delivery/destination.repository.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const intentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('failure notification destination attempt validation', () => {
  beforeEach(() => {
    withTenantScopedClient.mockReset();
  });

  it.each([1, 10])(
    'accepts load attempt boundary %s at the transaction seam',
    async (attemptNumber) => {
      withTenantScopedClient.mockResolvedValueOnce(undefined);
      await expect(
        loadDestination({} as Pool, {
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
      await expect(
        fenceDispatch({} as Pool, { attemptNumber, intentId, workspaceId }),
      ).resolves.toBeUndefined();
      expect(withTenantScopedClient).toHaveBeenCalledOnce();
    },
  );
});
