import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  workflowId,
  runId,
  workflowVersionId,
  authHeaders,
  start,
} from './fixture.js';

export function registerReadsRunInputOneStepOutput(): void {
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
}
