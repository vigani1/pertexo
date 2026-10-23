import { it, expect } from 'vitest';
import {
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  ownedDeliveryStore,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

export function registerMapsOrderedStartedTerminalFacts(): void {
  it('maps ordered started and terminal facts using exact physical attempt ownership', async () => {
    const invocationKey = 'version-a/manual';
    const state = checkpoint({
      runStatus: 'running',
      invocations: [
        {
          invocationKey,
          nodeId: 'manual',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    });
    const runId = await insertRun({ schedulerState: state, status: 'running' });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
           ) values ($1,$2,$3,'manual',$4,'{}','succeeded','safe',$5,1,$6::jsonb)`,
        [
          nodeRunId,
          workspaceA,
          runId,
          invocationKey,
          attemptId,
          JSON.stringify({
            kind: 'inline',
            value: { selectedPort: 'true' },
          }),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
           ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
        [
          attemptId,
          workspaceA,
          nodeRunId,
          JSON.stringify({
            kind: 'inline',
            value: { selectedPort: 'true' },
          }),
        ],
      );
      for (const [sequence, type] of [
        [2, 'node.started'],
        [3, 'node.succeeded'],
      ] as const)
        await client.query(
          `insert into app.run_events
               (workspace_id,workflow_run_id,sequence,type,payload)
             values ($1,$2,$3,$4,$5::jsonb)`,
          [
            workspaceA,
            runId,
            sequence,
            type,
            JSON.stringify({ nodeRunId, attemptId }),
          ],
        );
    });
    const loaded = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toEqual([
      expect.objectContaining({
        kind: 'cursor_only',
        eventName: 'node.started',
        sequence: 2,
        invocationKey,
        attemptId,
        attemptNumber: 1,
      }),
      expect.objectContaining({
        kind: 'outcome',
        sequence: 3,
        invocationKey,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      }),
    ]);
    expect(loaded.state.completedOutputs).toEqual([]);
  });

  it.each([1, 1_500, 10_000])(
    'loads %i cursor facts through the bounded public observation window',
    async (factCount) => {
      const invocationKey = 'cursor/boundary';
      const runId = await insertRun({
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: 'boundary',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        status: 'running',
      });
      const nodeRunId = randomUUID();
      const attemptId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number
           ) values ($1,$2,$3,'boundary',$4,'{}','running','safe',$5,1)`,
          [nodeRunId, workspaceA, runId, invocationKey, attemptId],
        );
        await client.query(
          `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'running','safe')`,
          [attemptId, workspaceA, nodeRunId],
        );
        await client.query(
          `insert into app.run_events (
             workspace_id,workflow_run_id,sequence,type,payload
           )
           select $1,$2,sequence,
                  case when sequence=2 then 'node.started' else 'node.progress' end,
                  $3::jsonb
           from generate_series(2,$4::int + 1) sequence`,
          [
            workspaceA,
            runId,
            JSON.stringify({ nodeRunId, attemptId }),
            factCount,
          ],
        );
      });
      const plans = await asRuntime(
        workerBaseUrl,
        workspaceA,
        async (client) => {
          await client.query('set local enable_seqscan=off');
          const events = await client.query<Record<'QUERY PLAN', unknown>>(
            `explain (analyze, buffers, costs false, format json)
             select event.sequence,event.type,event.payload,event.created_at
               from app.run_events event
              where event.workspace_id=$1 and event.workflow_run_id=$2
                and event.sequence >= 2
              order by event.sequence
              limit $3`,
            [workspaceA, runId, Math.min(factCount, 1_000)],
          );
          const attempts = await client.query<Record<'QUERY PLAN', unknown>>(
            `explain (analyze, buffers, costs false, format json)
             select attempt.id,node.id
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
              where attempt.workspace_id=$1
                and attempt.id=any($2::uuid[])
                and node.workflow_run_id=$3`,
            [workspaceA, [attemptId], runId],
          );
          return { events: events.rows, attempts: attempts.rows };
        },
      );
      const eventPlan = JSON.stringify(plans.events);
      const attemptPlan = JSON.stringify(plans.attempts);
      expect(eventPlan).toContain('"Relation Name":"run_events"');
      expect(eventPlan).toContain('"Node Type":"Index Scan"');
      expect(attemptPlan).toContain('"Relation Name":"node_attempts"');
      expect(attemptPlan).toContain('"Node Type":"Index Scan"');

      const loaded = await ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      });
      expect(loaded).toMatchObject({ kind: 'ready' });
      if (loaded.kind !== 'ready') throw new Error('expected ready state');
      expect(loaded.state.observations).toHaveLength(factCount);
      expect(loaded.state.observations[0]).toMatchObject({
        kind: 'cursor_only',
        eventName: 'node.started',
        sequence: 2,
        invocationKey,
        attemptNumber: 1,
      });
      expect(loaded.state.observations.at(-1)).toMatchObject({
        kind: 'cursor_only',
        eventName: factCount === 1 ? 'node.started' : 'node.progress',
        sequence: factCount + 1,
        invocationKey,
        attemptNumber: 1,
      });
    },
    30_000,
  );
}
