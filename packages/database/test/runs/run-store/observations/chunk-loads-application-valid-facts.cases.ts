import { it, expect } from 'vitest';
import {
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

import {
  measureObservationLoad,
  observedCoordinatorStore,
  observedKinds,
} from './fixture.js';

export function registerChunkLoadsApplicationValidFacts(): void {
  it('chunk-loads application-valid facts beyond 64 MiB of PostgreSQL text expansion', async () => {
    const invocationKey = 'version-a/exponent-heavy-progress';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        admittedInvocationKeys: [invocationKey],
        invocations: [
          {
            invocationKey,
            nodeId: 'exponent-heavy-progress',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const storageBytes = await asRuntime(
      workerBaseUrl,
      workspaceA,
      async (client) => {
        await client.query(
          `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,
               branch_context,status,side_effect_class,current_attempt_id,
               current_attempt_number
             ) values ($1,$2,$3,'exponent-heavy-progress',$4,'{}','running',
                       'safe',$5,1)`,
          [nodeRunId, workspaceA, runId, invocationKey, attemptId],
        );
        await client.query(
          `insert into app.node_attempts (
               id,workspace_id,node_run_id,attempt_number,status,side_effect_class
             ) values ($1,$2,$3,1,'running','safe')`,
          [attemptId, workspaceA, nodeRunId],
        );
        await client.query(
          `with numbers as (
               select jsonb_agg(1e308::numeric) as value
               from generate_series(1,500)
             )
             insert into app.run_events (
               workspace_id,workflow_run_id,sequence,type,payload
             )
             select $1,$2,sequence,'node.progress',jsonb_build_object(
               'nodeRunId',$3::text,'attemptId',$4::text,
               'numbers',numbers.value
             )
             from generate_series(2,451) sequence cross join numbers`,
          [workspaceA, runId, nodeRunId, attemptId],
        );
        const size = await client.query<{ bytes: string }>(
          `select sum(octet_length(payload::text))::bigint as bytes
             from app.run_events
             where workspace_id=$1 and workflow_run_id=$2 and sequence >= 2`,
          [workspaceA, runId],
        );
        return Number(size.rows[0]?.bytes);
      },
    );
    expect(storageBytes).toBeGreaterThan(64 * 1024 * 1024);

    const observed = observedCoordinatorStore();
    const loaded = await measureObservationLoad('numeric_expansion', () =>
      observed.store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).finally(() => observed.close());
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toHaveLength(450);
    expect(loaded.state.observations.at(0)).toMatchObject({ sequence: 2 });
    expect(loaded.state.observations.at(-1)).toMatchObject({ sequence: 451 });
    expect(
      observedKinds(observed.observedQueries).filter(
        (kind) => kind === 'fact_page',
      ).length,
    ).toBeGreaterThan(1);

    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 451,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 452,
            admittedInvocationKeys: [invocationKey],
            invocations: [
              {
                invocationKey,
                nodeId: 'exponent-heavy-progress',
                status: 'running',
                attemptNumber: 1,
              },
            ],
          }),
          events: [],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
  });
}
