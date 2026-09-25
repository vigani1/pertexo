import { describe, expect, it, vi } from 'vitest';

import {
  AuthorizationError,
  createActorContext,
  type WorkspaceStatus,
} from '../../src/workspaces/index.js';
import type {
  WorkflowRunPersistence,
  WorkflowRunStatisticsRecord,
} from '../../src/workflow-runs/ports.js';
import { GetWorkflowRunStatisticsUseCase } from '../../src/workflow-runs/statistics-use-case.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const workflowId = '33333333-3333-4333-8333-333333333333';

const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: '44444444-4444-4444-8444-444444444444',
  requestId: 'statistics-request',
});

const byStatus = {
  queued: 0,
  running: 1,
  waiting: 0,
  succeeded: 6,
  failed: 2,
  canceled: 0,
  timed_out: 1,
  outcome_unknown: 0,
};

function snapshot(
  workflows?: WorkflowRunStatisticsRecord['workflows'],
): WorkflowRunStatisticsRecord {
  return {
    asOf: '2026-09-25T12:00:00.123456Z',
    current: { queued: 0, running: 1, waiting: 2 },
    window: {
      duration: '24h',
      createdAtFrom: '2026-09-24T12:00:00.123456Z',
      createdAtBefore: '2026-09-25T12:00:00.123456Z',
      total: 10,
      byStatus,
    },
    ...(workflows === undefined ? {} : { workflows }),
  };
}

function access(workspaceStatus: WorkspaceStatus = 'active') {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'viewer' as const,
      membershipStatus: 'active' as const,
      workspaceStatus,
    }),
  };
}

function persistence(result: WorkflowRunStatisticsRecord = snapshot()) {
  return {
    statistics: vi
      .fn<WorkflowRunPersistence['statistics']>()
      .mockResolvedValue(result),
  };
}

describe('workflow run statistics use case', () => {
  it('reads the 24-hour window without a breakdown by default', async () => {
    const store = persistence();

    const result = await new GetWorkflowRunStatisticsUseCase(
      store,
      access(),
    ).execute({ actor, routeWorkspaceId: workspaceId });

    expect(store.statistics).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      window: '24h',
      includeWorkflows: false,
      includeWorkflowName: true,
    });
    expect(result).toEqual({ ...snapshot(), workflows: null });
  });

  it('asks for the workflow breakdown and hides names without workflow:read', async () => {
    const breakdown = {
      items: [{ workflowId, workflowName: null, total: 10, byStatus }],
      truncated: true,
    };
    const store = persistence(snapshot(breakdown));
    const policy = vi.fn(
      (_role: string, capability: string) => capability !== 'workflow:read',
    );

    const result = await new GetWorkflowRunStatisticsUseCase(
      store,
      access('pending_deletion'),
      policy,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      window: '7d',
      breakdown: 'workflow',
    });

    expect(policy).toHaveBeenCalledWith('viewer', 'workflow:read');
    expect(store.statistics).toHaveBeenCalledWith({
      workspaceId,
      window: '7d',
      includeWorkflows: true,
      includeWorkflowName: false,
    });
    expect(result.workflows).toEqual(breakdown);
  });

  it('does not disclose statistics to a non-member or a deleted workspace', async () => {
    const store = persistence();
    const outsider = {
      findAccess: vi.fn().mockResolvedValue(undefined),
    };

    for (const authorization of [outsider, access('deleted')])
      await expect(
        new GetWorkflowRunStatisticsUseCase(store, authorization).execute({
          actor,
          routeWorkspaceId: workspaceId,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    expect(store.statistics).not.toHaveBeenCalled();
  });

  it('refuses a snapshot that breaks the public contract', async () => {
    const store = persistence({
      ...snapshot(),
      window: { ...snapshot().window, byStatus: { ...byStatus, failed: -1 } },
    });

    await expect(
      new GetWorkflowRunStatisticsUseCase(store, access()).execute({
        actor,
        routeWorkspaceId: workspaceId,
      }),
    ).rejects.toThrow();
  });
});
