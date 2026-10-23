import { toProblem } from '../../../src/problems/registry.js';
import { runFailure } from '../../../src/problems/context/normalize.js';
import { throwApplicationError } from '../../../src/platform/http/application-error.js';
import { applicationError } from '../../../src/platform/http/index.js';

import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  workflowId,
  runId,
  workflowVersionId,
  authHeaders,
  mutationHeaders,
  start,
} from './fixture.js';

export function registerProtectsRecoveryPreviewAcceptanceCurrentCapabilities(): void {
  it('protects recovery preview and acceptance with current capabilities and CSRF', async () => {
    const { application, fixture } = await start('viewer');
    for (const method of ['GET', 'POST'] as const) {
      const response = await application.inject({
        method,
        url: `/v1/workspaces/${workspaceId}/runs/${runId}/${method === 'GET' ? 'recovery' : 'recover'}`,
        headers: method === 'GET' ? authHeaders : mutationHeaders,
        ...(method === 'GET'
          ? {}
          : { payload: { workflowVersionId, nodeRunId: runId } }),
      });
      expect(response.statusCode).toBe(404);
    }
    expect(fixture.recovery).not.toHaveBeenCalled();
    expect(fixture.recover).not.toHaveBeenCalled();
  });

  it('returns a safe preview, rejects changed input and missing CSRF, and preserves refusal reasons', async () => {
    const { application, fixture } = await start();
    fixture.recovery.mockResolvedValue({
      kind: 'eligible',
      workflowVersionId,
      versionNumber: 1,
      nodeRunId: runId,
      nodeId: 'http',
      nodeLabel: 'Send request',
      reusedCount: 2,
      sourceCompletedAt: '2026-10-13T00:00:00.000Z',
      effectRisk: 'possible_effects',
    });
    const preview = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/recovery`,
      headers: authHeaders,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      effectRisk: 'possible_effects',
      reusedCount: 2,
    });
    expect(fixture.recovery).toHaveBeenCalledWith({
      actorId,
      workspaceId,
      runId,
    });
    for (const body of [
      { workflowVersionId, nodeRunId: runId, input: {} },
      {
        workflowVersionId,
        nodeRunId: runId,
        acknowledgePossibleEffects: false,
      },
    ]) {
      const response = await application.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/runs/${runId}/recover`,
        headers: mutationHeaders,
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    }
    const noCsrf = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/recover`,
      headers: authHeaders,
      payload: { workflowVersionId, nodeRunId: runId },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(fixture.recover).not.toHaveBeenCalled();
    fixture.recover.mockImplementation(() =>
      throwApplicationError(
        toProblem(
          runFailure(
            applicationError('run.recovery_unavailable', {
              details: { reason: 'effects_acknowledgement_required' },
            }),
          ),
        ),
      ),
    );
    const rejected = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/recover`,
      headers: mutationHeaders,
      payload: { workflowVersionId, nodeRunId: runId },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      code: 'run.recovery_unavailable',
      reason: 'effects_acknowledgement_required',
    });
    expect(fixture.recover).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRunId: runId,
        nodeRunId: runId,
        workflowVersionId,
        scope: `workflow:${runId}:recover`,
        actorId,
      }),
    );
  });

  it('runs authentication and authorization guards before workflow persistence', async () => {
    const { application, fixture } = await start('viewer');

    const unauthenticated = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      status: 401,
      code: 'auth.unauthenticated',
    });
    expect(fixture.get).not.toHaveBeenCalled();

    const unauthenticatedList = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs`,
    });
    expect(unauthenticatedList.statusCode).toBe(401);
    expect(fixture.list).not.toHaveBeenCalled();

    const unauthorizedStart = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
      headers: mutationHeaders,
      payload: {},
    });
    expect(unauthorizedStart.statusCode).toBe(404);
    expect(unauthorizedStart.json()).toMatchObject({
      status: 404,
      code: 'resource.not_found',
    });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it('lists safe run summaries and rejects unsupported filters', async () => {
    const { application, fixture } = await start('viewer');
    const createdAt = new Date('2026-08-21T12:00:00.000Z');
    fixture.list.mockResolvedValue({
      items: [
        {
          id: runId,
          workspaceId,
          workflowId,
          workflowVersionId,
          status: 'succeeded',
          triggerType: 'manual',
          createdAt,
          updatedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          deadlineAt: null,
          cancelRequestedAt: null,
        },
      ],
    });

    const response = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs?limit=25&workflowId=${workflowId}&status=succeeded`,
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ id: runId, status: 'succeeded' }],
      nextCursor: null,
    });
    expect(fixture.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, workflowId, status: 'succeeded' }),
    );

    const invalid = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs?status=invalid`,
      headers: authHeaders,
    });
    expect(invalid.statusCode).toBe(400);
    expect(fixture.list).toHaveBeenCalledTimes(1);
  });
}
