import {
  ScheduleTriggerError,
  type ScheduleTriggerDatabase,
} from '@pertexo/database/testing';
import {
  scheduleManagementCommandResponseSchema,
  scheduleTriggerListResponseSchema,
} from '@pertexo/contracts/schedules';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleManagementService } from '../../src/schedules/service.js';

const trigger = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  nodeId: 'schedule',
  kind: 'schedule' as const,
  status: 'active' as const,
  healthStatus: 'healthy' as const,
  lastErrorCode: null,
  reconciledAt: null,
  recurrence: { kind: 'interval' as const, intervalMinutes: 15 },
  misfirePolicy: 'catch_up_once' as const,
  nextFireAt: new Date('2026-08-25T12:15:00.000Z'),
  lastFireAt: null,
};
const input = {
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workflowId: trigger.workflowId,
  triggerId: trigger.id,
  idempotencyKey: 'schedule-command',
};

describe('schedule management service', () => {
  it('uses the exact actor-scoped request hash and returns safe dates', async () => {
    const database = setup();
    const service = new ScheduleManagementService(database);
    await expect(service.setEnabled(input, false)).resolves.toMatchObject({
      replayed: false,
      trigger: { nextFireAt: '2026-08-25T12:15:00.000Z' },
    });
    expect(database.setEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: input.actorId,
        enabled: false,
      }),
    );
    const persisted = database.setEnabled.mock.calls[0]?.[0];
    expect(persisted?.requestHash).toBe(
      'd8071e7a107e6271da8cfc0e744ee4be2eca9fea75ddc851c737addc18782376',
    );
  });

  it('binds command identity only to the intended operation and target fields', async () => {
    const database = setup();
    const service = new ScheduleManagementService(database);
    await service.setEnabled(input, false);
    await service.setEnabled(
      {
        ...input,
        idempotencyKey: 'another-key',
        requestId: 'another-request',
        traceId: 'another-trace',
      },
      false,
    );
    await service.setEnabled(input, true);
    await service.setEnabled(
      { ...input, actorId: '11111111-1111-4111-8111-111111111111' },
      false,
    );
    await service.setEnabled(
      { ...input, workspaceId: '22222222-2222-4222-8222-222222222222' },
      false,
    );
    await service.setEnabled(
      { ...input, workflowId: '33333333-3333-4333-8333-333333333333' },
      false,
    );
    await service.setEnabled(
      { ...input, triggerId: '44444444-4444-4444-8444-444444444444' },
      false,
    );

    const hashes = database.setEnabled.mock.calls.map(
      ([request]) => request.requestHash,
    );
    expect(hashes[1]).toBe(hashes[0]);
    for (const changed of hashes.slice(2)) expect(changed).not.toBe(hashes[0]);
  });

  it('lists explicit public fields with nullable and present dates', async () => {
    const database = setup();
    const recordWithInternalField = {
      ...trigger,
      internalLease: 'must-not-leak',
    };
    database.list.mockResolvedValueOnce([
      recordWithInternalField,
      {
        ...trigger,
        id: '11111111-1111-4111-8111-111111111111',
        reconciledAt: new Date('2026-08-25T12:01:00.000Z'),
        lastFireAt: new Date('2026-08-25T12:00:00.000Z'),
      },
    ]);
    const service = new ScheduleManagementService(database);

    const result = await service.list(input);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      reconciledAt: null,
      lastFireAt: null,
      nextFireAt: '2026-08-25T12:15:00.000Z',
    });
    expect(result.items[1]).toMatchObject({
      reconciledAt: '2026-08-25T12:01:00.000Z',
      lastFireAt: '2026-08-25T12:00:00.000Z',
    });
    expect(scheduleTriggerListResponseSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('internalLease');
  });

  it('returns an empty list without fabricating schedule state', async () => {
    const database = setup();
    database.list.mockResolvedValueOnce([]);
    const service = new ScheduleManagementService(database);

    await expect(service.list(input)).resolves.toEqual({ items: [] });
  });

  it.each([[true], [false]] as const)(
    'forwards enabled=%s and projects a valid response',
    async (enabled) => {
      const database = setup();
      database.setEnabled.mockResolvedValueOnce({ trigger, replayed: true });
      const service = new ScheduleManagementService(database);

      const result = await service.setEnabled(input, enabled);

      expect(database.setEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ enabled }),
      );
      expect(result.replayed).toBe(true);
      expect(scheduleManagementCommandResponseSchema.parse(result)).toEqual(
        result,
      );
    },
  );

  it('maps hidden not-found and exact replay conflicts to stable problems', async () => {
    const database = setup();
    const service = new ScheduleManagementService(database);
    database.list.mockRejectedValueOnce(new ScheduleTriggerError('not_found'));
    await expect(service.list(input)).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    database.setEnabled.mockRejectedValueOnce(
      new ScheduleTriggerError('idempotency_conflict'),
    );
    await expect(service.setEnabled(input, true)).rejects.toMatchObject({
      code: 'request.idempotency_conflict',
    });
  });

  it('preserves unknown list and command errors by identity', async () => {
    const listDatabase = setup();
    const listFailure = new Error('list failed');
    listDatabase.list.mockRejectedValueOnce(listFailure);
    await expect(
      new ScheduleManagementService(listDatabase).list(input),
    ).rejects.toBe(listFailure);

    const commandDatabase = setup();
    const commandFailure = new Error('command failed');
    commandDatabase.setEnabled.mockRejectedValueOnce(commandFailure);
    await expect(
      new ScheduleManagementService(commandDatabase).setEnabled(input, true),
    ).rejects.toBe(commandFailure);
  });
});

function setup() {
  const list = vi
    .fn<ScheduleTriggerDatabase['list']>()
    .mockResolvedValue([trigger]);
  const setEnabled = vi
    .fn<ScheduleTriggerDatabase['setEnabled']>()
    .mockResolvedValue({ trigger, replayed: false });
  const unused = () => Promise.reject(new Error('not a command or list'));
  return {
    list,
    setEnabled,
    listOccurrences: vi.fn<ScheduleTriggerDatabase['listOccurrences']>(unused),
    nextFireTimes: vi.fn<ScheduleTriggerDatabase['nextFireTimes']>(unused),
    previewFireTimes:
      vi.fn<ScheduleTriggerDatabase['previewFireTimes']>(unused),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies ScheduleTriggerDatabase;
}
