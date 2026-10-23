import { expect, it } from 'vitest';

import {
  GetWorkflowRunUseCase,
  ReplayWorkflowRunUseCase,
  StartWorkflowRunUseCase,
  WorkflowRunNotFoundError,
} from '../../../src/workflow-runs/use-cases.js';
import {
  GetWorkflowNodeRunOutputUseCase,
  GetWorkflowRunInputUseCase,
} from '../../../src/workflow-runs/run-data/use-cases.js';

import {
  actorId,
  workspaceId,
  workflowId,
  workflowVersionId,
  runId,
  actor,
  authorization,
  persistence,
} from './fixture.js';

export function registerKeepsStartReplayCapabilitiesDistinct(): void {
  it('keeps start and replay capabilities distinct', async () => {
    const fixture = persistence();
    const access = authorization('builder');

    await expect(
      new StartWorkflowRunUseCase(fixture.store, access).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        idempotencyKey: 'run-start-builder-42',
      }),
    ).resolves.toMatchObject({ replayed: false });

    await expect(
      new ReplayWorkflowRunUseCase(fixture.store, access).execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        workflowVersionId,
        idempotencyKey: 'run-replay-builder-42',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });

    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.replay).not.toHaveBeenCalled();
  });

  it('reads run data with run access and hides another workspace or run', async () => {
    const fixture = persistence();
    const nodeRunId = '99999999-9999-4999-8999-999999999999';
    await expect(
      new GetWorkflowRunInputUseCase(
        fixture.store,
        authorization('viewer'),
      ).execute({ actor, routeWorkspaceId: workspaceId, runId }),
    ).resolves.toEqual({ input: { kind: 'expired' } });
    expect(fixture.readInput).toHaveBeenCalledWith({
      actorId,
      workspaceId,
      runId,
    });

    const output = new GetWorkflowNodeRunOutputUseCase(
      fixture.store,
      authorization('viewer'),
    );
    await expect(
      output.execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        nodeRunId,
      }),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    await expect(
      output.execute({
        actor,
        routeWorkspaceId: '11111111-1111-4111-8111-111111111111',
        runId,
        nodeRunId,
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(fixture.readNodeRunOutput).toHaveBeenCalledTimes(1);
  });

  it('rejects a route workspace mismatch before touching persistence', async () => {
    const fixture = persistence();
    const useCase = new StartWorkflowRunUseCase(fixture.store, authorization());

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: '11111111-1111-4111-8111-111111111111',
        workflowId,
        idempotencyKey: 'run-start-42',
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it('authorizes and canonicalizes an explicit user replay command', async () => {
    const fixture = persistence();
    const useCase = new ReplayWorkflowRunUseCase(
      fixture.store,
      authorization(),
    );

    const result = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      workflowVersionId,
      idempotencyKey: 'run-replay-42',
      input: { b: 2, a: 1 },
      deadlineAt: '2026-08-21T18:00:00.000Z',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });

    expect(result.run.id).toBe(runId);
    expect(result.replayed).toBe(false);
    expect(fixture.replay).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        workspaceId,
        sourceRunId: runId,
        workflowVersionId,
        scope: `workflow:${runId}:replay`,
        input: { b: 2, a: 1 },
        deadlineAt: new Date('2026-08-21T18:00:00.000Z'),
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
    const command = fixture.replay.mock.calls[0]?.[0];
    expect(command?.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(command?.requestHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects a replay route workspace mismatch before touching persistence', async () => {
    const fixture = persistence();
    const useCase = new ReplayWorkflowRunUseCase(
      fixture.store,
      authorization(),
    );

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: '11111111-1111-4111-8111-111111111111',
        runId,
        workflowVersionId,
        idempotencyKey: 'run-replay-42',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(fixture.replay).not.toHaveBeenCalled();
  });

  it('requires the dedicated replay capability instead of run start access', async () => {
    const fixture = persistence();
    const useCase = new ReplayWorkflowRunUseCase(
      fixture.store,
      authorization('viewer'),
    );

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        workflowVersionId,
        idempotencyKey: 'run-replay-viewer-42',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(fixture.replay).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'pending_deletion'] as const)(
    'rejects replay in a %s workspace before persistence',
    async (workspaceStatus) => {
      const fixture = persistence();
      const access = authorization();
      access.findAccess.mockResolvedValue({
        actorId,
        workspaceId,
        role: 'owner',
        membershipStatus: 'active',
        workspaceStatus,
      });
      await expect(
        new ReplayWorkflowRunUseCase(fixture.store, access).execute({
          actor,
          routeWorkspaceId: workspaceId,
          runId,
          workflowVersionId,
          idempotencyKey: `replay-${workspaceStatus}`,
          input: {},
        }),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      expect(fixture.replay).not.toHaveBeenCalled();
    },
  );

  it('reads bounded run state only after run:read authorization', async () => {
    const fixture = persistence();
    const result = await new GetWorkflowRunUseCase(
      fixture.store,
      authorization('viewer'),
    ).execute({ actor, routeWorkspaceId: workspaceId, runId });

    expect(result.run.id).toBe(runId);
    expect(result.nodes).toEqual([]);
    expect(fixture.get).toHaveBeenCalledWith({
      actorId,
      workspaceId,
      runId,
      includeWorkflowName: true,
    });
  });
}
