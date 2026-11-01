import type { NotificationDestinationStore } from '@pertexo/core/testing';
import { vi } from 'vitest';

import { createActorContext } from '../../../../src/authorization/index.js';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const destinationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const connectionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const workflowId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const record = {
  id: destinationId,
  workspaceId,
  kind: 'slack' as const,
  status: 'enabled' as const,
  currentVersion: 1,
  config: { kind: 'slack' as const, connectionId, channelId: 'C12345' },
  createdAt: new Date('2026-08-25T10:00:00.000Z'),
  updatedAt: new Date('2026-08-25T10:00:00.000Z'),
  internalMetadata: 'must-not-escape',
};

export function request(
  headers: Record<string, string | readonly string[]> = {},
) {
  return {
    requestId: 'request-42',
    traceId: 'trace-42',
    headers,
    identitySession: {
      userId: actorId,
      sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expiresAt: new Date('2026-08-25T20:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

export const command = {
  actor: createActorContext({
    actorId,
    workspaceId,
    sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    requestId: 'request-42',
    traceId: 'trace-42',
  }),
  routeWorkspaceId: workspaceId,
  requestId: 'request-42',
  traceId: 'trace-42',
};

export function persistence() {
  return {
    create: vi
      .fn<NotificationDestinationStore['create']>()
      .mockResolvedValue(record),
    get: vi.fn<NotificationDestinationStore['get']>().mockResolvedValue(record),
    list: vi
      .fn<NotificationDestinationStore['list']>()
      .mockResolvedValue([record]),
    appendVersion: vi
      .fn<NotificationDestinationStore['appendVersion']>()
      .mockResolvedValue(record),
    setStatus: vi
      .fn<NotificationDestinationStore['setStatus']>()
      .mockResolvedValue(record),
    setWorkflowPolicy:
      vi.fn<NotificationDestinationStore['setWorkflowPolicy']>(),
    clearWorkflowPolicy:
      vi.fn<NotificationDestinationStore['clearWorkflowPolicy']>(),
    getWorkflowPolicy: vi
      .fn<NotificationDestinationStore['getWorkflowPolicy']>()
      .mockResolvedValue(record),
    close: vi.fn<NotificationDestinationStore['close']>(),
  } satisfies NotificationDestinationStore;
}
