import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FailureNotificationStoreSupport from '../src/execution/failure-notification-store-support.js';

const tenantState = vi.hoisted<{ client: unknown }>(() => ({
  client: undefined,
}));
const auditFailureNotification = vi.hoisted(() => vi.fn());
const insertFailureNotificationDeliveryOutbox = vi.hoisted(() => vi.fn());

vi.mock('../src/tenant-access/workspace.js', () => ({
  withTenantScopedClient: async (
    _pool: unknown,
    _context: unknown,
    work: (client: unknown) => Promise<unknown>,
  ) => await work(tenantState.client),
}));

vi.mock(
  '../src/execution/failure-notification-store-support.js',
  async (importOriginal) => ({
    ...(await importOriginal<typeof FailureNotificationStoreSupport>()),
    auditFailureNotification,
    insertFailureNotificationDeliveryOutbox,
  }),
);

import { createFailureNotificationCompletionStore } from '../src/execution/failure-notification-completion-store.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const intentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type LockedIntent = Readonly<{
  delivery_attempts: number;
  possibly_dispatched: boolean | null;
  side_effect_class: 'safe' | 'idempotent_with_key' | 'unsafe';
  status: 'claimed' | 'dispatching';
}>;

function completionHarness(row: LockedIntent) {
  const query = vi.fn<
    (
      text: string,
      parameters?: readonly unknown[],
    ) => Promise<{ rows: readonly unknown[] }>
  >((text) =>
    Promise.resolve({
      rows: text.includes('for update')
        ? [row]
        : text.includes("set status='retry'")
          ? [{ next_delivery_at: new Date('2026-09-11T00:00:00.000Z') }]
          : [],
    }),
  );
  tenantState.client = { query };
  return {
    complete: createFailureNotificationCompletionStore({} as Pool)
      .completeDelivery,
    query,
  };
}

describe('failure notification completion policy', () => {
  beforeEach(() => {
    auditFailureNotification.mockReset();
    insertFailureNotificationDeliveryOutbox.mockReset();
  });

  it.each([
    {
      scenario: 'safe retry with attempts remaining',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'claimed',
      } satisfies LockedIntent,
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: false,
    },
    {
      scenario: 'unsafe predispatch retry with attempts remaining',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'unsafe',
        status: 'claimed',
      } satisfies LockedIntent,
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: false,
    },
    {
      scenario: 'safe ambiguous dispatch remains retryable',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'dispatching',
      } satisfies LockedIntent,
      result: {
        kind: 'outcome_unknown' as const,
        possiblyDispatched: true,
        safeErrorCode: 'provider.ambiguous',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: true,
    },
    {
      scenario: 'idempotent ambiguous dispatch remains retryable',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'idempotent_with_key',
        status: 'dispatching',
      } satisfies LockedIntent,
      result: {
        kind: 'outcome_unknown' as const,
        possiblyDispatched: true,
        safeErrorCode: 'provider.ambiguous',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: true,
    },
    {
      scenario: 'unsafe retry after dispatch becomes unknown',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'unsafe',
        status: 'dispatching',
      } satisfies LockedIntent,
      result: {
        kind: 'retry' as const,
        possiblyDispatched: true,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'outcome_unknown',
      expectedUnresolved: true,
    },
    {
      scenario: 'claimed unsafe retry preserves prior uncertainty',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: true,
        side_effect_class: 'unsafe',
        status: 'claimed',
      } satisfies LockedIntent,
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: true,
    },
    {
      scenario: 'delivered dispatch',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'idempotent_with_key',
        status: 'dispatching',
      } satisfies LockedIntent,
      result: {
        kind: 'delivered' as const,
        possiblyDispatched: true,
        providerReference: 'provider-message-1',
      },
      maxAttempts: 3,
      expectedStatus: 'delivered',
      expectedUnresolved: true,
    },
    {
      scenario: 'unsafe ambiguous dispatch',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'unsafe',
        status: 'dispatching',
      } satisfies LockedIntent,
      result: {
        kind: 'outcome_unknown' as const,
        possiblyDispatched: true,
        safeErrorCode: 'provider.ambiguous',
      },
      maxAttempts: 3,
      expectedStatus: 'outcome_unknown',
      expectedUnresolved: true,
    },
    {
      scenario: 'exhausted safe retry',
      row: {
        delivery_attempts: 3,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'dispatching',
      } satisfies LockedIntent,
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'dead_letter',
      expectedUnresolved: false,
    },
    {
      scenario: 'exhausted idempotent delivery with prior uncertainty',
      row: {
        delivery_attempts: 3,
        possibly_dispatched: true,
        side_effect_class: 'idempotent_with_key',
        status: 'dispatching',
      } satisfies LockedIntent,
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'outcome_unknown',
      expectedUnresolved: true,
    },
  ] as const)(
    '$scenario',
    async ({
      row,
      result,
      maxAttempts,
      expectedStatus,
      expectedUnresolved,
    }) => {
      const { complete, query } = completionHarness(row);

      await expect(
        complete({
          workspaceId,
          intentId,
          attemptNumber: row.delivery_attempts,
          maxAttempts,
          retryDelaySeconds: 5,
          result: { schemaVersion: 1, ...result },
        }),
      ).resolves.toBe('completed');

      if (expectedStatus === 'retry') {
        expect(query.mock.calls[1]?.[0]).toContain("set status='retry'");
        expect(query.mock.calls[1]?.[1]?.[4]).toBe(expectedUnresolved);
        expect(insertFailureNotificationDeliveryOutbox).toHaveBeenCalledOnce();
      } else {
        expect(query.mock.calls[1]?.[1]?.[2]).toBe(expectedStatus);
        expect(query.mock.calls[1]?.[1]?.[4]).toBe(expectedUnresolved);
        expect(insertFailureNotificationDeliveryOutbox).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      kind: 'delivered' as const,
      possiblyDispatched: true,
      providerReference: 'provider-message-1',
    },
    {
      kind: 'outcome_unknown' as const,
      possiblyDispatched: true,
      safeErrorCode: 'provider.ambiguous',
    },
  ] as const)(
    'rejects incompatible claimed $kind completion before mutation',
    async (result) => {
      const { complete, query } = completionHarness({
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'claimed',
      });

      await expect(
        complete({
          workspaceId,
          intentId,
          attemptNumber: 1,
          maxAttempts: 3,
          retryDelaySeconds: 5,
          result: { schemaVersion: 1, ...result },
        }),
      ).rejects.toThrow('Predispatch completion result is incompatible');
      expect(query).toHaveBeenCalledOnce();
    },
  );
});
