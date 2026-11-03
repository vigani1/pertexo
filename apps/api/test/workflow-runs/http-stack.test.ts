import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanWorkflowRunsRealNestHTTPStack,
  actorId,
  workspaceId,
  workflowId,
  runId,
  workflowVersionId,
  authHeaders,
  mutationHeaders,
  start,
} from './http-stack/fixture.js';
import { toProblem } from '../../src/problems/registry.js';
import { runFailure } from '../../src/problems/context/normalize.js';
import { throwApplicationError } from '../../src/platform/http/application-error.js';
import { applicationError } from '../../src/platform/http/index.js';
import {
  IdempotencyRequestConflictError,
  ExecutionStateConflictError,
  WorkflowRunNotExecutableError,
} from '@pertexo/core/runs';
import { WorkflowRunNotFoundError } from '../../src/workflow-runs/workflow-runs.service.js';
import { usageCapacitySnapshot } from './usage/capacity.fixture.js';

describe('workflow runs real Nest HTTP stack', () => {
  afterEach(cleanWorkflowRunsRealNestHTTPStack);
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

  it('takes a start or cancel with no body at all, which is what most callers try first', async () => {
    const { application, fixture } = await start();
    fixture.start.mockRejectedValueOnce(new WorkflowRunNotExecutableError());
    fixture.cancel.mockRejectedValueOnce(
      new ExecutionStateConflictError('execution.run_terminal'),
    );
    const started = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
      headers: mutationHeaders,
    });
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(started.statusCode).not.toBe(400);
    const canceled = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/cancel`,
      headers: mutationHeaders,
    });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(canceled.statusCode).not.toBe(400);
  });

  // What a script's client usually sends: the header it always sets, and nothing else.
  it('takes a start or cancel with a JSON content type and no body', async () => {
    const { application, fixture } = await start();
    fixture.start.mockRejectedValueOnce(new WorkflowRunNotExecutableError());
    fixture.cancel.mockRejectedValueOnce(
      new ExecutionStateConflictError('execution.run_terminal'),
    );
    const headers = {
      ...mutationHeaders,
      'content-type': 'application/json',
    };
    const started = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
      headers,
    });
    expect(started.statusCode, started.payload).not.toBe(400);
    expect(fixture.start).toHaveBeenCalledOnce();
    const canceled = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/cancel`,
      headers,
    });
    expect(canceled.statusCode, canceled.payload).not.toBe(400);
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it('still refuses a body that isn’t JSON, or isn’t the right shape', async () => {
    const { application, fixture } = await start();
    for (const payload of ['{', '[]', '"text"', '{"unknown":true}']) {
      const response = await application.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
        headers: { ...mutationHeaders, 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode, payload).toBe(400);
    }
    expect(fixture.start).not.toHaveBeenCalled();
  });

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

  it('reads a run input and one step output for a role that reads runs', async () => {
    const { application, fixture } = await start('viewer');
    const nodeRunId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    fixture.readInput.mockResolvedValue({
      kind: 'inline',
      value: { customerId: 'customer-42' },
    });
    fixture.readNodeRunOutput.mockResolvedValue({ kind: 'none' });

    const input = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/input`,
      headers: authHeaders,
    });
    expect(input.statusCode).toBe(200);
    expect(input.headers['cache-control']).toBe('private, no-store');
    expect(input.json()).toEqual({
      input: { kind: 'inline', value: { customerId: 'customer-42' } },
    });
    expect(fixture.readInput).toHaveBeenCalledWith({
      actorId,
      workspaceId,
      runId,
    });

    const output = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${nodeRunId}/output`,
      headers: authHeaders,
    });
    expect(output.statusCode).toBe(200);
    expect(output.headers['cache-control']).toBe('private, no-store');
    expect(output.json()).toEqual({ output: { kind: 'none' } });
    expect(fixture.readNodeRunOutput).toHaveBeenCalledWith({
      actorId,
      workspaceId,
      runId,
      nodeRunId,
    });

    fixture.readNodeRunInput.mockResolvedValue({
      kind: 'inline',
      value: { orderId: 'A-17' },
    });
    const stepInput = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${nodeRunId}/input`,
      headers: authHeaders,
    });
    expect(stepInput.statusCode).toBe(200);
    expect(stepInput.headers['cache-control']).toBe('private, no-store');
    expect(stepInput.json()).toEqual({
      input: { kind: 'inline', value: { orderId: 'A-17' } },
    });

    fixture.readNodeRunOutput.mockResolvedValue(undefined);
    const missing = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${nodeRunId}/output`,
      headers: authHeaders,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'resource.not_found' });

    const invalid = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/not-a-run/output`,
      headers: authHeaders,
    });
    expect(invalid.statusCode).toBe(400);

    const unauthenticated = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/input`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(fixture.readInput).toHaveBeenCalledTimes(1);
  });

  it('reads step health and one step’s runs for a role that reads runs', async () => {
    const { application, fixture } = await start('viewer');
    const at = new Date('2026-09-26T10:00:00.000Z');
    fixture.stepHealth.mockResolvedValue({
      runsConsidered: 2,
      oldestRunAt: at,
      items: [
        {
          nodeId: 'charge',
          runs: 2,
          succeeded: 1,
          failed: 1,
          skipped: 0,
          lastStatus: 'failed',
          lastRanAt: at,
          medianDurationMs: 1_200,
          p95DurationMs: 1_200,
        },
      ],
    });
    fixture.stepRuns.mockResolvedValue([
      {
        runId,
        runStatus: 'failed',
        runCreatedAt: at,
        workflowVersionId,
        nodeRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        invocationKey: 'charge',
        status: 'failed',
        attempts: 3,
        startedAt: at,
        completedAt: at,
        safeErrorCode: 'provider.timeout',
      },
    ]);

    const health = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/step-health`,
      headers: authHeaders,
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      runsConsidered: 2,
      oldestRunAt: at.toISOString(),
      items: [{ nodeId: 'charge', failed: 1, lastRanAt: at.toISOString() }],
    });

    const runs = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/steps/charge/runs?limit=5`,
      headers: authHeaders,
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toMatchObject({
      items: [{ runId, status: 'failed', safeErrorCode: 'provider.timeout' }],
    });
    expect(fixture.stepRuns).toHaveBeenCalledWith({
      actorId,
      workspaceId,
      workflowId,
      nodeId: 'charge',
      limit: 5,
    });

    const tooMany = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/steps/charge/runs?limit=500`,
      headers: authHeaders,
    });
    expect(tooMany.statusCode).toBe(400);

    fixture.stepHealth.mockResolvedValue(undefined);
    const hidden = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/step-health`,
      headers: authHeaders,
    });
    expect(hidden.json()).toMatchObject({ code: 'resource.not_found' });
    expect(hidden.statusCode).toBe(404);
  });
});
