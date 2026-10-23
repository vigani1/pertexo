import type { Role } from '@pertexo/workflow-model';

import { expect, it } from 'vitest';

import {
  GetWorkflowRunUseCase,
  ListWorkflowRunsUseCase,
} from '../../../src/workflow-runs/use-cases.js';

import {
  workspaceId,
  workflowId,
  runId,
  actor,
  authorization,
  run,
  persistence,
} from './fixture.js';

export function registerPassesExactRunValuePairThrough(): void {
  it('passes an exact run-value pair through paging without changing other filters', async () => {
    const fixture = persistence();
    fixture.list.mockResolvedValue({ items: [run()] });
    await new ListWorkflowRunsUseCase(fixture.store, authorization()).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runValueKey: 'orderId',
      runValue: '',
      workflowId,
      status: 'queued',
      limit: 10,
    });
    expect(fixture.list).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        runValueKey: 'orderId',
        runValue: '',
        workflowId,
        status: 'queued',
        limit: 10,
      }),
    );
  });

  it('binds exact-precision pagination cursors to workspace and normalized filters', async () => {
    const fixture = persistence();
    fixture.list
      .mockResolvedValueOnce({
        items: [run()],
        nextCursor: {
          createdAt: '2026-08-21T12:00:00.000123Z',
          id: runId,
        },
      })
      .mockResolvedValueOnce({ items: [] });
    const useCase = new ListWorkflowRunsUseCase(fixture.store, authorization());
    const first = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      workflowNamePrefix: 'Oper',
      status: 'queued',
      createdAtFrom: '2026-08-21T14:00:00+02:00',
      limit: 1,
    });

    expect(first.nextCursor).toEqual(expect.any(String));
    if (first.nextCursor === null) throw new Error('expected a next cursor');
    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      workflowNamePrefix: 'Oper',
      status: 'queued',
      createdAtFrom: '2026-08-21T12:00:00.000000Z',
      limit: 1,
      after: first.nextCursor,
    });
    expect(fixture.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workflowNamePrefix: 'Oper',
        includeWorkflowName: true,
        createdAtFrom: '2026-08-21T12:00:00.000000Z',
        after: {
          createdAt: '2026-08-21T12:00:00.000123Z',
          id: runId,
        },
      }),
    );

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        workflowNamePrefix: 'Different',
        status: 'running',
        limit: 1,
        after: first.nextCursor,
      }),
    ).rejects.toThrow('workflow run cursor is invalid');
    expect(fixture.list).toHaveBeenCalledTimes(2);
  });

  it('accepts a legacy no-prefix cursor only for another no-prefix request', async () => {
    const fixture = persistence();
    fixture.list
      .mockResolvedValueOnce({
        items: [run()],
        nextCursor: {
          createdAt: '2026-08-21T12:00:00.000123Z',
          id: runId,
        },
      })
      .mockResolvedValueOnce({ items: [] });
    const useCase = new ListWorkflowRunsUseCase(fixture.store, authorization());
    const first = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      limit: 1,
    });
    if (first.nextCursor === null) throw new Error('expected a next cursor');
    const payload = JSON.parse(
      Buffer.from(first.nextCursor, 'base64url').toString('utf8'),
    ) as { filters: Record<string, unknown> };
    expect(payload.filters).not.toHaveProperty('workflowNamePrefix');

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        limit: 1,
        after: first.nextCursor,
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowNamePrefix: 'Oper',
        limit: 1,
        after: first.nextCursor,
      }),
    ).rejects.toThrow('workflow run cursor is invalid');
    expect(fixture.list).toHaveBeenCalledTimes(2);
  });

  it('omits workflow metadata and rejects name filtering at a run-only policy seam', async () => {
    const fixture = persistence();
    fixture.get.mockImplementation((input) =>
      Promise.resolve({
        run: {
          ...run(),
          workflowName: input.includeWorkflowName ? 'Operations' : null,
        },
        nodes: [],
      }),
    );
    fixture.list.mockImplementation((input) =>
      Promise.resolve({
        items: [
          {
            ...run(),
            workflowName: input.includeWorkflowName ? 'Operations' : null,
          },
        ],
      }),
    );
    const runOnlyPolicy = (_role: Role, capability: string) =>
      capability === 'run:read';
    const access = authorization();
    const detail = await new GetWorkflowRunUseCase(
      fixture.store,
      access,
      runOnlyPolicy,
    ).execute({ actor, routeWorkspaceId: workspaceId, runId });
    expect(detail.run.workflowName).toBeNull();
    expect(fixture.get).toHaveBeenCalledWith(
      expect.objectContaining({ includeWorkflowName: false }),
    );

    const listUseCase = new ListWorkflowRunsUseCase(
      fixture.store,
      access,
      runOnlyPolicy,
    );
    await expect(
      listUseCase.execute({ actor, routeWorkspaceId: workspaceId }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ workflowName: null })],
    });
    await expect(
      listUseCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowNamePrefix: 'Oper',
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(fixture.list).toHaveBeenCalledTimes(1);
  });

  it('preserves fractional run-history boundaries through the use-case seam', async () => {
    const fixture = persistence();
    fixture.list.mockResolvedValue({ items: [] });
    await new ListWorkflowRunsUseCase(fixture.store, authorization()).execute({
      actor,
      routeWorkspaceId: workspaceId,
      createdAtFrom: '2026-08-21T00:00:00.000100Z',
      createdAtBefore: '2026-08-21T00:00:00.000900Z',
    });

    expect(fixture.list).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAtFrom: '2026-08-21T00:00:00.000100Z',
        createdAtBefore: '2026-08-21T00:00:00.000900Z',
      }),
    );
  });
}
