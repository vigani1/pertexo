import type { ApiTokenScope } from '@pertexo/contracts';
import { expect, it } from 'vitest';

import { createAutomationActorContext } from '../../../src/authorization/index.js';
import { WorkflowRunNotFoundError } from '../../../src/workflow-runs/access/authorize.js';
import {
  GetWorkflowRunUseCase,
  ListWorkflowRunsUseCase,
} from '../../../src/workflow-runs/use-cases.js';

import {
  actorId,
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

  it.each([
    { scopes: ['run:read'] as const, workflowName: null },
    {
      scopes: ['run:read', 'workflow:read'] as const,
      workflowName: 'Operations',
    },
  ])(
    'shows workflow names to a token only with workflow:read ($scopes)',
    async ({ scopes, workflowName }) => {
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
      const token = tokenActor(scopes);
      const access = authorization('owner');

      const detail = await new GetWorkflowRunUseCase(
        fixture.store,
        access,
      ).execute({ actor: token, routeWorkspaceId: workspaceId, runId });
      expect(detail.run.workflowName).toBe(workflowName);

      await expect(
        new ListWorkflowRunsUseCase(fixture.store, access).execute({
          actor: token,
          routeWorkspaceId: workspaceId,
        }),
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ workflowName })],
      });
    },
  );

  it('hides that a workflow name matched from a token without workflow:read', async () => {
    const fixture = persistence();
    await expect(
      new ListWorkflowRunsUseCase(
        fixture.store,
        authorization('owner'),
      ).execute({
        actor: tokenActor(['run:read']),
        routeWorkspaceId: workspaceId,
        workflowNamePrefix: 'Oper',
      }),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    expect(fixture.list).not.toHaveBeenCalled();
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

function tokenActor(scopes: readonly ApiTokenScope[]) {
  return createAutomationActorContext({
    actorId,
    workspaceId,
    tokenId: '99999999-9999-4999-8999-999999999999',
    requestId: 'request-token',
    scopes,
  });
}
