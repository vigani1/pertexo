import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  workspaceId,
  otherWorkspaceId,
  actorId,
  workflowId,
  database,
  digest,
  startInput,
  ownerQuery,
} from './fixture.js';

export function registerReadsEachStepAcrossWorkflow(): void {
  it('reads each step across the workflow’s recent runs, and one step’s runs', async () => {
    const first = await database.start(startInput());
    const second = await database.start(
      startInput(digest('request-2'), digest('key-2')),
    );
    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class,
          safe_error_code,started_at,completed_at,created_at)
       values
         (gen_random_uuid(),$1,$2,'fetch','fetch','{}','succeeded','safe',
          null, now() - interval '10 seconds', now() - interval '9 seconds',
          now() - interval '10 seconds'),
         (gen_random_uuid(),$1,$3,'fetch','fetch','{}','succeeded','safe',
          null, now() - interval '5 seconds', now() - interval '2 seconds',
          now() - interval '5 seconds'),
         (gen_random_uuid(),$1,$3,'charge','charge','{}','failed','safe',
          'provider.timeout', now() - interval '2 seconds', now(),
          now() - interval '2 seconds')`,
      [workspaceId, first.run.id, second.run.id],
    );

    const health = await database.stepHealth({
      actorId: actorId,
      workspaceId,
      workflowId,
    });
    expect(health).toMatchObject({ runsConsidered: 2 });
    expect(health?.oldestRunAt).toBeInstanceOf(Date);
    expect(health?.items).toEqual([
      expect.objectContaining({
        nodeId: 'charge',
        runs: 1,
        succeeded: 0,
        failed: 1,
        lastStatus: 'failed',
        medianDurationMs: null,
      }),
      expect.objectContaining({
        nodeId: 'fetch',
        runs: 2,
        succeeded: 2,
        failed: 0,
        lastStatus: 'succeeded',
        medianDurationMs: 2_000,
        p95DurationMs: 2_900,
      }),
    ]);

    const charge = await database.stepRuns({
      actorId: actorId,
      workspaceId,
      workflowId,
      nodeId: 'charge',
      limit: 20,
    });
    expect(charge).toEqual([
      expect.objectContaining({
        runId: second.run.id,
        status: 'failed',
        attempts: 0,
        safeErrorCode: 'provider.timeout',
      }),
    ]);
    await expect(
      database.stepRuns({
        actorId: actorId,
        workspaceId,
        workflowId,
        nodeId: 'fetch',
        limit: 1,
      }),
    ).resolves.toEqual([expect.objectContaining({ runId: second.run.id })]);
    await expect(
      database.stepRuns({
        actorId: actorId,
        workspaceId,
        workflowId,
        nodeId: 'never',
        limit: 5,
      }),
    ).resolves.toEqual([]);
    await expect(
      database.stepHealth({
        actorId: actorId,
        workspaceId: otherWorkspaceId,
        workflowId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.stepRuns({
        actorId: actorId,
        workspaceId,
        workflowId: randomUUID(),
        nodeId: 'fetch',
        limit: 5,
      }),
    ).resolves.toBeUndefined();
  });
}
