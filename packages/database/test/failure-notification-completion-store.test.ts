import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FailureNotificationStoreSupport from '../src/execution/failure-notification-store-support.js';

const tenantState = vi.hoisted<{ client: unknown }>(() => ({
  client: undefined,
}));
const auditFailureNotification = vi.hoisted(() => vi.fn());
const insertFailureNotificationDeliveryOutbox = vi.hoisted(() => vi.fn());
const withTenantScopedClient = vi.hoisted(() => vi.fn());

vi.mock('../src/tenant-access/workspace.js', () => ({
  withTenantScopedClient,
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
  status: string;
}>;

function completionHarness(row: LockedIntent | undefined) {
  const query = vi.fn<
    (
      text: string,
      parameters?: readonly unknown[],
    ) => Promise<{ rows: readonly unknown[] }>
  >((text) =>
    Promise.resolve({
      rows: text.includes('for update')
        ? row === undefined
          ? []
          : [row]
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
      scenario:
        'defensive corrupt-state policy preserves prior uncertainty on a claimed unsafe row',
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
        expect(query.mock.calls[1]?.[1]?.[2]).toBe(5);
        expect(query.mock.calls[1]?.[1]?.[4]).toBe(expectedUnresolved);
        expect(insertFailureNotificationDeliveryOutbox).toHaveBeenCalledWith(
          expect.anything(),
          {
            attemptNumber: row.delivery_attempts + 1,
            availableAt: new Date('2026-09-11T00:00:00.000Z'),
            intentId,
            workspaceId,
          },
        );
        expect(auditFailureNotification).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            attemptNumber: row.delivery_attempts,
            factType: 'retry_scheduled',
            intentId,
            possiblyDispatched: expectedUnresolved,
            workspaceId,
          }),
        );
      } else {
        expect(query.mock.calls[1]?.[1]?.[2]).toBe(expectedStatus);
        expect(query.mock.calls[1]?.[1]?.[4]).toBe(expectedUnresolved);
        expect(query.mock.calls[1]?.[1]?.[5]).toBe(
          result.kind === 'delivered' ? result.providerReference : null,
        );
        expect(insertFailureNotificationDeliveryOutbox).not.toHaveBeenCalled();
        expect(auditFailureNotification).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            attemptNumber: row.delivery_attempts,
            factType:
              expectedStatus === 'delivered'
                ? 'delivered'
                : expectedStatus === 'outcome_unknown'
                  ? 'outcome_unknown'
                  : 'dead_lettered',
            intentId,
            possiblyDispatched: expectedUnresolved,
            workspaceId,
          }),
        );
      }
    },
  );

  it.each([
    ['attempt number', 'attemptNumber', 0],
    ['attempt number', 'attemptNumber', -1],
    ['attempt number', 'attemptNumber', 1.5],
    ['attempt number', 'attemptNumber', Number.NaN],
    ['attempt number', 'attemptNumber', Number.POSITIVE_INFINITY],
    ['attempt number', 'attemptNumber', 11],
    ['maximum attempts', 'maxAttempts', 0],
    ['maximum attempts', 'maxAttempts', -1],
    ['maximum attempts', 'maxAttempts', 1.5],
    ['maximum attempts', 'maxAttempts', Number.NaN],
    ['maximum attempts', 'maxAttempts', Number.POSITIVE_INFINITY],
    ['maximum attempts', 'maxAttempts', 11],
    ['retry delay', 'retryDelaySeconds', -1],
    ['retry delay', 'retryDelaySeconds', 0.5],
    ['retry delay', 'retryDelaySeconds', Number.NaN],
    ['retry delay', 'retryDelaySeconds', Number.POSITIVE_INFINITY],
    ['retry delay', 'retryDelaySeconds', 3_601],
  ] as const)(
    'rejects invalid $0 $2 before transaction checkout',
    async (_label, field, value) => {
      const { complete, query } = completionHarness({
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'dispatching',
      });
      await expect(
        complete({
          workspaceId,
          intentId,
          attemptNumber: 1,
          maxAttempts: 3,
          retryDelaySeconds: 5,
          result: {
            kind: 'retry',
            possiblyDispatched: false,
            safeErrorCode: 'provider.unavailable',
            schemaVersion: 1,
          },
          [field]: value,
        }),
      ).rejects.toThrow(/Invalid/u);
      expect(withTenantScopedClient).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(auditFailureNotification).not.toHaveBeenCalled();
      expect(insertFailureNotificationDeliveryOutbox).not.toHaveBeenCalled();
    },
  );

  it('accepts zero retry delay for terminal completion but rejects it before retry mutation', async () => {
    const terminal = completionHarness({
      delivery_attempts: 10,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'dispatching',
    });
    await expect(
      terminal.complete({
        workspaceId,
        intentId,
        attemptNumber: 10,
        maxAttempts: 10,
        retryDelaySeconds: 0,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.exhausted',
          schemaVersion: 1,
        },
      }),
    ).resolves.toBe('completed');

    const retry = completionHarness({
      delivery_attempts: 1,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'dispatching',
    });
    await expect(
      retry.complete({
        workspaceId,
        intentId,
        attemptNumber: 1,
        maxAttempts: 10,
        retryDelaySeconds: 0,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.unavailable',
          schemaVersion: 1,
        },
      }),
    ).rejects.toThrow('Retry delay must be positive');
    expect(retry.query).toHaveBeenCalledOnce();
  });

  it('accepts the maximum retry delay and attempt-control boundaries', async () => {
    const maximumDelay = completionHarness({
      delivery_attempts: 1,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'claimed',
    });
    await expect(
      maximumDelay.complete({
        workspaceId,
        intentId,
        attemptNumber: 1,
        maxAttempts: 10,
        retryDelaySeconds: 3_600,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.unavailable',
          schemaVersion: 1,
        },
      }),
    ).resolves.toBe('completed');
    expect(maximumDelay.query.mock.calls[1]?.[1]?.[2]).toBe(3_600);

    const minimumMaximum = completionHarness({
      delivery_attempts: 1,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'claimed',
    });
    await expect(
      minimumMaximum.complete({
        workspaceId,
        intentId,
        attemptNumber: 1,
        maxAttempts: 1,
        retryDelaySeconds: 0,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.exhausted',
          schemaVersion: 1,
        },
      }),
    ).resolves.toBe('completed');
    expect(minimumMaximum.query.mock.calls[1]?.[1]?.[2]).toBe('dead_letter');
  });

  it.each([
    ['missing intent', undefined, 1],
    [
      'terminal intent',
      {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'delivered',
      },
      1,
    ],
    [
      'older attempt',
      {
        delivery_attempts: 2,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'dispatching',
      },
      1,
    ],
    [
      'newer attempt',
      {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'dispatching',
      },
      2,
    ],
  ] as const)(
    'returns stale for $0 without mutation',
    async (_label, row, attemptNumber) => {
      const { complete, query } = completionHarness(row);
      await expect(
        complete({
          workspaceId,
          intentId,
          attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 5,
          result: {
            kind: 'retry',
            possiblyDispatched: false,
            safeErrorCode: 'provider.unavailable',
            schemaVersion: 1,
          },
        }),
      ).resolves.toBe('stale');
      expect(query).toHaveBeenCalledOnce();
      expect(auditFailureNotification).not.toHaveBeenCalled();
      expect(insertFailureNotificationDeliveryOutbox).not.toHaveBeenCalled();
    },
  );

  it('rejects a pre-aborted completion before client work', async () => {
    const controller = new AbortController();
    const reason = new Error('completion canceled');
    controller.abort(reason);
    const { complete, query } = completionHarness({
      delivery_attempts: 1,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'dispatching',
    });
    await expect(
      complete({
        workspaceId,
        intentId,
        attemptNumber: 1,
        maxAttempts: 3,
        retryDelaySeconds: 5,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.unavailable',
          schemaVersion: 1,
        },
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(query).not.toHaveBeenCalled();
  });

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
      expect(auditFailureNotification).not.toHaveBeenCalled();
      expect(insertFailureNotificationDeliveryOutbox).not.toHaveBeenCalled();
    },
  );

  it('rejects a malformed delivery result before transaction checkout', async () => {
    const { complete, query } = completionHarness({
      delivery_attempts: 1,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'dispatching',
    });
    await expect(
      complete({
        workspaceId,
        intentId,
        attemptNumber: 1,
        maxAttempts: 3,
        retryDelaySeconds: 5,
        result: {
          schemaVersion: 1,
          kind: 'delivered',
          possiblyDispatched: false,
        } as never,
      }),
    ).rejects.toThrow();
    expect(withTenantScopedClient).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
