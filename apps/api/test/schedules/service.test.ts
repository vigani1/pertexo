import {
  ScheduleTriggerIdempotencyConflictError,
  ScheduleTriggerNotFoundError,
  type ScheduleTriggerDatabase,
} from '@pertexo/database/testing';
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
  it('uses an actor-scoped request hash and returns safe dates', async () => {
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
    expect(persisted?.requestHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('maps hidden not-found and exact replay conflicts to stable problems', async () => {
    const database = setup();
    const service = new ScheduleManagementService(database);
    database.list.mockRejectedValueOnce(new ScheduleTriggerNotFoundError());
    await expect(service.list(input)).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    database.setEnabled.mockRejectedValueOnce(
      new ScheduleTriggerIdempotencyConflictError(),
    );
    await expect(service.setEnabled(input, true)).rejects.toMatchObject({
      code: 'request.idempotency_conflict',
    });
  });
});

function setup() {
  const list = vi
    .fn<ScheduleTriggerDatabase['list']>()
    .mockResolvedValue([trigger]);
  const setEnabled = vi
    .fn<ScheduleTriggerDatabase['setEnabled']>()
    .mockResolvedValue({ trigger, replayed: false });
  return {
    list,
    setEnabled,
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies ScheduleTriggerDatabase;
}
