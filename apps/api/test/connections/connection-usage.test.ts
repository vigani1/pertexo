import { describe, expect, it, vi } from 'vitest';
import { connectionUsageResponseSchema } from '@pertexo/contracts/connections';

import {
  ListConnectionUsageUseCase,
  encodeConnectionUsageCursor,
  decodeConnectionUsageCursor,
} from '../../src/connections/connection-usage.js';
import { InvalidConnectionCursorError } from '../../src/connections/cursor.js';
import { toResponse } from '../../src/connections/use-case-support.js';
import {
  actor,
  actorId,
  authorization,
  connectionId,
  record,
  workspaceId,
} from './support/use-case-fixture.js';

const workflowVersionId = '11111111-1111-4111-8111-111111111111';
const item = {
  workflowId: '22222222-2222-4222-8222-222222222222',
  workflowName: 'Archived Slack sender',
  workflowLifecycleStatus: 'archived' as const,
  workflowVersionId,
  versionNumber: 3,
  isCurrentPublication: false,
  operationKeys: ['send_message'],
};
const cursor = () =>
  encodeConnectionUsageCursor({
    kind: 'connection_usage',
    workspaceId,
    connectionId,
    workflowVersionId,
  });

describe('connection usage read', () => {
  it('maps separate bounded run and transition metadata without relabeling it as a test', () => {
    const observedAt = new Date('2026-10-01T00:00:00.000Z');
    expect(
      toResponse(
        record({
          lastRunObservedAt: observedAt,
          lastHealthTransitionAt: observedAt,
          lastHealthTransitionSource: 'run',
        }),
      ).health,
    ).toEqual({
      lastTestedAt: null,
      lastHealthyAt: null,
      lastErrorCode: null,
      lastRunObservedAt: observedAt.toISOString(),
      lastHealthTransitionAt: observedAt.toISOString(),
      lastHealthTransitionSource: 'run',
    });
    expect(toResponse(record()).health.lastRunObservedAt).toBeNull();
  });
  it('passes bounded paging to persistence and returns safe historical labels', async () => {
    const listConnectionUsage = vi
      .fn()
      .mockResolvedValue({ items: [item], nextCursor: { workflowVersionId } });
    const useCase = new ListConnectionUsageUseCase(
      { listConnectionUsage },
      authorization(),
    );
    const response = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      limit: 1,
      after: cursor(),
    });
    expect(listConnectionUsage).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      actorId,
      connectionId,
      limit: 1,
      after: { workflowVersionId },
    });
    expect(connectionUsageResponseSchema.parse(response)).toEqual({
      items: [item],
      nextCursor: cursor(),
    });
    expect(JSON.stringify(response)).not.toMatch(
      /secret|credential|graph_json/iu,
    );
  });

  it.each(['removed', 'suspended'])(
    'denies %s membership without reading usage',
    async (membershipStatus) => {
      const access = authorization();
      access.findAccess.mockResolvedValue({
        actorId,
        workspaceId,
        role: 'owner',
        membershipStatus,
        workspaceStatus: 'active',
      } as never);
      const listConnectionUsage = vi.fn();
      await expect(
        new ListConnectionUsageUseCase({ listConnectionUsage }, access).execute(
          { actor, routeWorkspaceId: workspaceId, connectionId },
        ),
      ).rejects.toThrow();
      expect(listConnectionUsage).not.toHaveBeenCalled();
    },
  );

  it('permits viewer read with both readable capabilities and omits absent paging', async () => {
    const access = authorization();
    access.findAccess.mockResolvedValue({
      actorId,
      workspaceId,
      role: 'viewer',
      membershipStatus: 'active',
      workspaceStatus: 'active',
    } as never);
    const listConnectionUsage = vi.fn().mockResolvedValue({ items: [] });
    const result = await new ListConnectionUsageUseCase(
      { listConnectionUsage },
      access,
    ).execute({ actor, routeWorkspaceId: workspaceId, connectionId });
    expect(result).toEqual({ items: [], nextCursor: null });
    expect(listConnectionUsage).toHaveBeenCalledWith({
      workspaceId,
      actorId,
      connectionId,
    });
  });

  it.each([
    'not-a-cursor',
    Buffer.from('{}').toString('base64url'),
    encodeConnectionUsageCursor({
      kind: 'connection_usage',
      workspaceId: workflowVersionId,
      connectionId,
      workflowVersionId,
    }),
    encodeConnectionUsageCursor({
      kind: 'connection_usage',
      workspaceId,
      connectionId: workflowVersionId,
      workflowVersionId,
    }),
    cursor() + '=',
  ])('rejects malformed, scope-swapped or noncanonical cursors', (value) => {
    expect(() =>
      decodeConnectionUsageCursor(value, workspaceId, connectionId),
    ).toThrow(InvalidConnectionCursorError);
  });
});
