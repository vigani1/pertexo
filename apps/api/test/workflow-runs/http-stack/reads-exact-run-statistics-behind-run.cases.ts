import {
  IdempotencyRequestConflictError,
  ExecutionStateConflictError,
  WorkflowRunNotExecutableError,
} from '@pertexo/core/runs';
import { WorkflowRunNotFoundError } from '../../../src/workflow-runs/use-cases.js';
import { expect, it } from 'vitest';

import { usageCapacitySnapshot } from '../usage/capacity.fixture.js';

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

export function registerReadsExactRunStatisticsBehindRun(): void {
  it('reads exact run statistics behind the run-read guards', async () => {
    const { application, fixture } = await start('viewer');
    const byStatus = {
      queued: 1,
      running: 2,
      waiting: 0,
      succeeded: 4,
      failed: 1,
      canceled: 0,
      timed_out: 0,
      outcome_unknown: 0,
    };
    const snapshot = {
      asOf: '2026-08-21T12:00:00.000123Z',
      current: { queued: 1, running: 2, waiting: 3 },
      window: {
        duration: '1h' as const,
        createdAtFrom: '2026-08-21T11:00:00.000123Z',
        createdAtBefore: '2026-08-21T12:00:00.000123Z',
        total: 8,
        byStatus,
      },
      workflows: {
        items: [{ workflowId, workflowName: 'Intake', total: 8, byStatus }],
        truncated: false,
      },
    };
    fixture.statistics.mockResolvedValue(snapshot);

    const unauthenticated = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/run-statistics`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const hidden = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${runId}/run-statistics`,
      headers: authHeaders,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: 'resource.not_found' });
    const invalid = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/run-statistics?window=30d`,
      headers: authHeaders,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      code: 'request.invalid',
      detail: 'The workflow run request is invalid.',
    });
    expect(fixture.statistics).not.toHaveBeenCalled();

    const response = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/run-statistics?window=1h&breakdown=workflow`,
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(fixture.statistics).toHaveBeenCalledExactlyOnceWith({
      actorId,
      workspaceId,
      window: '1h',
      includeWorkflows: true,
      includeWorkflowName: true,
    });
  });

  it('reads exact operational capacity as a viewer with no-store and session isolation', async () => {
    const { application, fixture } = await start('viewer');
    fixture.usageCapacity.mockResolvedValue(usageCapacitySnapshot());
    const unauthenticated = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/usage-capacity`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const hidden = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${runId}/usage-capacity`,
      headers: authHeaders,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: 'resource.not_found' });
    expect(fixture.usageCapacity).not.toHaveBeenCalled();
    const response = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/usage-capacity`,
      headers: authHeaders,
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual(usageCapacitySnapshot());
    expect(fixture.usageCapacity).toHaveBeenCalledTimes(1);
    expect(fixture.usageCapacity.mock.calls[0]?.[0].workspaceId).toBe(
      workspaceId,
    );
    expect(fixture.usageCapacity.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it.each(['pending_deletion', 'deleted'] as const)(
    'denies capacity without persistence for a %s workspace',
    async (status) => {
      const { application, fixture } = await start('viewer', status);
      const response = await application.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/usage-capacity`,
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'resource.not_found' });
      expect(fixture.usageCapacity).not.toHaveBeenCalled();
    },
  );

  it('maps workflow domain failures to exact public status and problem bodies', async () => {
    const { application, fixture } = await start();
    fixture.start.mockRejectedValueOnce(new IdempotencyRequestConflictError());
    fixture.replay.mockRejectedValueOnce(new WorkflowRunNotExecutableError());
    fixture.get.mockRejectedValueOnce(new WorkflowRunNotFoundError());
    fixture.cancel.mockRejectedValueOnce(
      new ExecutionStateConflictError('execution.run_terminal'),
    );

    const startResponse = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
      headers: mutationHeaders,
      payload: {},
    });
    expect(startResponse.statusCode).toBe(409);
    expect(startResponse.json()).toMatchObject({
      status: 409,
      code: 'request.idempotency_conflict',
    });

    const replayResponse = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/replay`,
      headers: { ...mutationHeaders, 'idempotency-key': 'replay-http-stack' },
      payload: { workflowVersionId, input: null },
    });
    expect(replayResponse.statusCode).toBe(409);
    expect(replayResponse.json()).toMatchObject({
      status: 409,
      code: 'workflow.not_published',
    });

    const getResponse = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}`,
      headers: authHeaders,
    });
    expect(getResponse.statusCode).toBe(404);
    expect(getResponse.json()).toMatchObject({
      status: 404,
      code: 'resource.not_found',
    });

    const cancelResponse = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/cancel`,
      headers: { ...mutationHeaders, 'idempotency-key': 'cancel-http-stack' },
      payload: {},
    });
    expect(cancelResponse.statusCode).toBe(409);
    expect(cancelResponse.json()).toMatchObject({
      status: 409,
      code: 'run.not_cancelable',
    });
  });
}
