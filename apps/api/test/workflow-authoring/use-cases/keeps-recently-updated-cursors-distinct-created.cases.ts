import { expect, it, vi } from 'vitest';
import {
  InvalidWorkflowCursorError,
  ListWorkflowVersionsUseCase,
  ListWorkflowsUseCase,
} from '../../../src/workflow-authoring/use-cases.js';

import {
  workspaceId,
  workflowId,
  actor,
  workflow,
  version,
  authorization,
  persistence,
  encodedCursor,
} from './fixture.js';

export function registerKeepsRecentlyUpdatedCursorsDistinctCreated(): void {
  it('keeps recently-updated cursors distinct from created-order cursors', async () => {
    const cursor = {
      positionAt: '2026-08-21T12:00:00.000900Z',
      id: workflowId,
    };
    const listWorkflows = vi
      .fn()
      .mockResolvedValueOnce({ items: [workflow()], nextCursor: cursor })
      .mockResolvedValueOnce({ items: [] });
    const useCase = new ListWorkflowsUseCase(
      persistence({ listWorkflows }),
      authorization(),
    );
    const first = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      order: 'updated_desc',
    });
    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      order: 'updated_desc',
      after: first.nextCursor ?? '',
    });
    expect(listWorkflows).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: cursor, order: 'updated_desc' }),
    );
    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        after: first.nextCursor ?? '',
      }),
    ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
  });

  it('rejects cursor payload fields outside the feature-private contract', async () => {
    const listWorkflows = vi.fn();
    const useCase = new ListWorkflowsUseCase(
      persistence({ listWorkflows }),
      authorization(),
    );
    const cursor = Buffer.from(
      JSON.stringify({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: workflowId,
        unexpected: true,
      }),
      'utf8',
    ).toString('base64url');

    await expect(
      useCase.execute({ actor, routeWorkspaceId: workspaceId, after: cursor }),
    ).rejects.toMatchObject({ name: 'InvalidWorkflowCursorError' });
    expect(listWorkflows).not.toHaveBeenCalled();
  });

  it('reads an exact immutable version through the authorized persistence seam', async () => {
    const listVersions = vi.fn().mockResolvedValue({ items: [version()] });
    const useCase = new ListWorkflowVersionsUseCase(
      persistence({ listVersions }),
      authorization(),
    );
    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        versionId: version().id,
      }),
    ).resolves.toMatchObject({
      items: [{ id: version().id }],
      nextCursor: null,
    });
    expect(listVersions).toHaveBeenCalledWith({
      actorId: actor.actorId,
      workspaceId,
      workflowId,
      versionId: version().id,
    });
  });

  it('keeps workflow and version cursor variants distinct', async () => {
    const listVersions = vi
      .fn()
      .mockResolvedValueOnce({
        items: [version()],
        nextCursor: { beforeVersionNumber: 2 },
      })
      .mockResolvedValueOnce({ items: [] });
    const useCase = new ListWorkflowVersionsUseCase(
      persistence({ listVersions }),
      authorization(),
    );

    const first = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
    });
    expect(first.nextCursor).toBe(
      'eyJraW5kIjoidmVyc2lvbnMiLCJiZWZvcmVWZXJzaW9uTnVtYmVyIjoyfQ',
    );
    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      after: first.nextCursor ?? '',
    });

    expect(listVersions).toHaveBeenLastCalledWith(
      expect.objectContaining({ beforeVersionNumber: 2 }),
    );
  });

  it.each([
    { name: 'empty input', cursor: '' },
    {
      name: 'malformed decoded JSON',
      cursor: Buffer.from('{', 'utf8').toString('base64url'),
    },
    {
      name: 'the version variant',
      cursor: encodedCursor({ kind: 'versions', beforeVersionNumber: 2 }),
    },
    {
      name: 'an unknown field',
      cursor: encodedCursor({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: workflowId,
        unknown: true,
      }),
    },
    {
      name: 'an absent date',
      cursor: encodedCursor({ kind: 'workflow', id: workflowId }),
    },
    {
      name: 'an invalid date',
      cursor: encodedCursor({
        kind: 'workflow',
        createdAt: 'not-a-date',
        id: workflowId,
      }),
    },
    {
      name: 'an invalid workflow ID',
      cursor: encodedCursor({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: 'not-a-uuid',
      }),
    },
  ])(
    'rejects workflow cursor with $name before listing',
    async ({ cursor }) => {
      const listWorkflows = vi.fn();
      await expect(
        new ListWorkflowsUseCase(
          persistence({ listWorkflows }),
          authorization(),
        ).execute({ actor, routeWorkspaceId: workspaceId, after: cursor }),
      ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
      expect(listWorkflows).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'the workflow variant',
      cursor: encodedCursor({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: workflowId,
      }),
    },
    {
      name: 'an absent version',
      cursor: encodedCursor({ kind: 'versions' }),
    },
    {
      name: 'a zero version',
      cursor: encodedCursor({ kind: 'versions', beforeVersionNumber: 0 }),
    },
    {
      name: 'a fractional version',
      cursor: encodedCursor({ kind: 'versions', beforeVersionNumber: 1.5 }),
    },
    {
      name: 'an unknown field',
      cursor: encodedCursor({
        kind: 'versions',
        beforeVersionNumber: 2,
        unknown: true,
      }),
    },
  ])('rejects version cursor with $name before listing', async ({ cursor }) => {
    const listVersions = vi.fn();
    await expect(
      new ListWorkflowVersionsUseCase(
        persistence({ listVersions }),
        authorization(),
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        after: cursor,
      }),
    ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
    expect(listVersions).not.toHaveBeenCalled();
  });
}
