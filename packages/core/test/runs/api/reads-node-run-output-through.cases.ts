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
  replayInput,
  ownerQuery,
} from './fixture.js';

export function registerReadsNodeRunOutputThrough(): void {
  it('reads a node run output only through its own run', async () => {
    const started = await database.start(startInput());
    const other = await database.start(
      startInput(digest('request-2'), digest('key-2')),
    );
    const withOutput = randomUUID();
    const withoutOutput = randomUUID();
    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class,output_ref,input_ref)
       values
         ($1,$3,$4,'set-fields','set-fields','{}','succeeded','safe',$5::jsonb,
          $6::jsonb),
         ($2,$3,$4,'stop','stop','{}','pending','safe',null,null)`,
      [
        withOutput,
        withoutOutput,
        workspaceId,
        started.run.id,
        JSON.stringify({
          kind: 'inline',
          value: { report: 'daily-summary', rows: 42 },
        }),
        JSON.stringify({
          kind: 'inline',
          value: { customerId: 'customer-42' },
        }),
      ],
    );
    await expect(
      database.readNodeRunInput({
        actorId: actorId,
        workspaceId,
        runId: started.run.id,
        nodeRunId: withOutput,
      }),
    ).resolves.toEqual({
      kind: 'inline',
      value: { customerId: 'customer-42' },
    });
    await expect(
      database.readNodeRunInput({
        actorId: actorId,
        workspaceId,
        runId: started.run.id,
        nodeRunId: withoutOutput,
      }),
    ).resolves.toEqual({ kind: 'none' });

    await expect(
      database.readNodeRunOutput({
        actorId: actorId,
        workspaceId,
        runId: started.run.id,
        nodeRunId: withOutput,
      }),
    ).resolves.toEqual({
      kind: 'inline',
      value: { report: 'daily-summary', rows: 42 },
    });
    await expect(
      database.readNodeRunOutput({
        actorId: actorId,
        workspaceId,
        runId: started.run.id,
        nodeRunId: withoutOutput,
      }),
    ).resolves.toEqual({ kind: 'none' });
    await expect(
      database.readNodeRunOutput({
        actorId: actorId,
        workspaceId,
        runId: other.run.id,
        nodeRunId: withOutput,
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.readNodeRunOutput({
        actorId: actorId,
        workspaceId: otherWorkspaceId,
        runId: started.run.id,
        nodeRunId: withOutput,
      }),
    ).resolves.toBeUndefined();
  });

  it('lists replay lineage and the step that explains an unsuccessful run', async () => {
    const loopVersionId = randomUUID();
    const step = (id: string, label?: string) => ({
      id,
      definition: { key: 'core.http_request', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
      ...(label === undefined ? {} : { label }),
    });
    await ownerQuery(
      `insert into app.workflow_versions
         (id, workspace_id, workflow_id, version_number,
          graph_json, checksum, executable_json, published_by)
       values ($1, $2, $3, 3, $4::jsonb, $5, $6::jsonb, $7)`,
      [
        loopVersionId,
        workspaceId,
        workflowId,
        JSON.stringify({
          settings: {},
          edges: [],
          nodes: [
            {
              ...step('each-order'),
              definition: { key: 'core.for_each', version: 1 },
              structured: {
                kind: 'for_each',
                maxIterations: 10,
                maxConcurrency: 1,
                body: { nodes: [step('charge', 'Charge card')], edges: [] },
              },
            },
          ],
        }),
        `wf:sha256:${'d'.repeat(64)}`,
        JSON.stringify({ marker: 'run-api-loop' }),
        actorId,
      ],
    );
    const source = await database.start(startInput());
    const replay = await database.replay(
      replayInput(source.run.id, digest('replay-request-1'), {
        idempotencyKeyHash: digest('replay-key-1'),
        selectedWorkflowVersionId: loopVersionId,
      }),
    );
    await ownerQuery(
      `update app.workflow_runs
       set status = 'failed', started_at = created_at, completed_at = created_at
       where id = $1`,
      [replay.run.id],
    );
    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class,safe_error_code,
          started_at,completed_at)
       values
         (gen_random_uuid(),$1,$2,'charge','charge-0','{}','failed','safe',
          'provider.rejected', now() - interval '2 seconds', now() - interval '1 second'),
         (gen_random_uuid(),$1,$2,'charge','charge-1','{}','failed','safe',
          'provider.timeout', now(), now())`,
      [workspaceId, replay.run.id],
    );

    const page = await database.list({
      actorId: actorId,
      workspaceId,
      limit: 10,
      includeWorkflowName: true,
    });
    expect(page.items.find((run) => run.id === replay.run.id)).toMatchObject({
      replaySourceRunId: source.run.id,
      failedStep: {
        nodeId: 'charge',
        label: 'Charge card',
        definitionKey: 'core.http_request',
        safeErrorCode: 'provider.timeout',
      },
    });
    expect(page.items.find((run) => run.id === source.run.id)).toMatchObject({
      replaySourceRunId: null,
      failedStep: null,
    });
    await expect(
      database.get({ actorId: actorId, workspaceId, runId: replay.run.id }),
    ).resolves.toMatchObject({ run: { replaySourceRunId: source.run.id } });
  });
}
