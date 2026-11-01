import 'reflect-metadata';

import { expect, it } from 'vitest';
import {
  WorkflowFolderConflictError,
  WorkflowTagConflictError,
  WorkflowNotFoundError,
} from '@pertexo/core/authoring';

import {
  actorId,
  workflowId,
  sessionId,
  headers,
  prefix,
  placement,
  routes,
  setup,
} from './fixture.js';

export function registerRejectsInvalidWorkspaceFolderWorkflowParams(): void {
  it('rejects invalid workspace/folder/workflow params and any nonempty read query', async () => {
    const f = await setup();
    for (const url of [
      '/v1/workspaces/invalid/workflow-folders',
      `${prefix}/workflow-folders/invalid/rename`,
      `${prefix}/workflows/invalid/folder`,
    ]) {
      expect(
        (
          await f.app.inject({
            method: url.endsWith('workflow-folders') ? 'GET' : 'POST',
            url,
            headers,
            ...(url.endsWith('workflow-folders')
              ? {}
              : { payload: routes[2].payload }),
          })
        ).statusCode,
        url,
      ).toBe(400);
    }
    for (const query of ['?limit=1', '?limit=1&limit=2', '?cursor=opaque'])
      expect(
        (
          await f.inject(routes[0], {
            url: prefix + '/workflow-folders' + query,
          })
        ).statusCode,
      ).toBe(400);
    for (const route of routes) expect(f.port(route)).not.toHaveBeenCalled();
  });

  it.each([
    'name',
    'limit',
    'revision',
    'hierarchy',
    'not_empty',
    'not_visible',
  ] as const)(
    'sanitizes folder %s conflicts into a 409 problem',
    async (kind) => {
      const f = await setup();
      const error = Object.assign(new WorkflowFolderConflictError(kind), {
        message: 'private-message',
        currentRevision: 99,
        body: { proof: 'private-proof' },
        cause: new Error('private-cause'),
      });
      f.folders.createFolder.mockRejectedValueOnce(error);
      const response = await f.inject(routes[1]);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toMatch(
        /^workflow\.folder_/u,
      );
      expect(response.body).not.toContain('private');
      expect(response.body).not.toContain('currentRevision');
      expect(response.body).not.toContain('proof');
    },
  );

  it('retains ordered partial bulk results without leaking folder placement or error properties', async () => {
    const f = await setup();
    const ids = [workflowId, sessionId, actorId];
    f.batches.executeBatchItem.mockResolvedValueOnce({
      ...placement,
      workflowId,
    });
    f.batches.executeBatchItem.mockRejectedValueOnce(
      Object.assign(new WorkflowTagConflictError('organization_revision'), {
        currentRevision: 99,
        body: 'private',
      }),
    );
    f.batches.executeBatchItem.mockRejectedValueOnce(
      new WorkflowNotFoundError(),
    );
    const response = await f.inject(routes[6], {
      payload: {
        operation: 'move',
        folderId: null,
        items: ids.map((id) => ({
          workflowId: id,
          expectedOrganizationRevision: 1,
        })),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          workflowId,
          status: 'updated',
          organizationRevision: 2,
          replayed: false,
        },
        {
          workflowId: sessionId,
          status: 'conflict',
          code: 'workflow.organization_revision_conflict',
        },
        { workflowId: actorId, status: 'not_visible' },
      ],
    });
    for (const [index, id] of ids.entries())
      expect(f.batches.executeBatchItem).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ workflowId: id }),
      );
    expect(response.body).not.toContain('folderId');
    expect(response.body).not.toContain('private');
  });
}
