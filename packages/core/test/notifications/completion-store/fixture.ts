import type { Pool } from 'pg';
import { vi } from 'vitest';
import type * as FailureNotificationStoreSupport from '../../../src/notifications/delivery/evidence.repository.js';
import { createFailureNotificationCompletionStore } from '../../../src/notifications/delivery/completion.repository.js';

const tenantState = vi.hoisted<{ client: unknown }>(() => ({
  client: undefined,
}));

const auditFailureNotification = vi.hoisted(() => vi.fn());

const insertFailureNotificationDeliveryOutbox = vi.hoisted(() => vi.fn());

const withTenantScopedClient = vi.hoisted(() => vi.fn());

vi.mock('../../../../database/dist/tenant-access/transactions.js', () => ({
  withTenantScopedClient,
}));

vi.mock(
  '../../../src/notifications/delivery/evidence.repository.js',
  async (importOriginal) => ({
    ...(await importOriginal<typeof FailureNotificationStoreSupport>()),
    auditFailureNotification,
    insertFailureNotificationDeliveryOutbox,
  }),
);

export const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const intentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export type LockedIntent = Readonly<{
  delivery_attempts: number;
  possibly_dispatched: boolean | null;
  side_effect_class: 'safe' | 'idempotent_with_key' | 'unsafe';
  status: string;
}>;

export function completionHarness(row: LockedIntent | undefined) {
  const query = vi
    .fn<
      (
        statement: string | { text: string; rowMode?: string },
        parameters?: readonly unknown[],
      ) => Promise<{ rows: readonly unknown[] }>
    >()
    .mockResolvedValueOnce({
      rows:
        row === undefined
          ? []
          : [
              [
                row.status,
                row.delivery_attempts,
                row.side_effect_class,
                row.possibly_dispatched,
              ],
            ],
    })
    .mockResolvedValue({ rows: [['2026-09-11T00:00:00.000Z']] });
  tenantState.client = { query };
  return {
    complete: createFailureNotificationCompletionStore({} as Pool)
      .completeDelivery,
    query,
  };
}

export function beforeEachFixture1() {
  auditFailureNotification.mockReset();
  insertFailureNotificationDeliveryOutbox.mockReset();
  withTenantScopedClient.mockReset();
  withTenantScopedClient.mockImplementation(
    async (
      _pool: unknown,
      _context: unknown,
      work: (client: unknown) => Promise<unknown>,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) => {
      options.signal?.throwIfAborted();
      return work(tenantState.client);
    },
  );
}

export {
  auditFailureNotification,
  insertFailureNotificationDeliveryOutbox,
  withTenantScopedClient,
};
