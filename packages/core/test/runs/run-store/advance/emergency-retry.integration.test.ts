import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { workspaceA } from '../run-store.fixture.js';
import { emergencyRun, query } from './emergency.fixture.js';

it.each(['ready', 'running', 'succeeded'] as const)(
  'keeps prior keyed dispatch uncertainty when stopping a %s retry, unless success resolves it',
  async (currentStatus) => {
    const f = await emergencyRun();
    const nodeId = randomUUID(),
      prior = randomUUID(),
      current = randomUUID();
    await query(
      "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,provider_idempotency_key) values($1,$2,$3,'step','step',$4::text,'idempotent_with_key','provider-key')",
      [
        nodeId,
        workspaceA,
        f.runId,
        currentStatus === 'ready' ? 'ready' : 'running',
      ],
    );
    await query(
      `insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,dispatch_marked_at,executor_failure_kind,executor_error_kind,executor_possibly_dispatched,retry_decision,safe_error_code,completed_at,provider_idempotency_key)
      values($1,$2,$3,1,'failed','idempotent_with_key',clock_timestamp(),'retry','network',true,'retry','execution.network',clock_timestamp(),'provider-key')`,
      [prior, workspaceA, nodeId],
    );
    await query(
      `insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,provider_idempotency_key,lease_owner,lease_expires_at,fence_token,completed_at)
      values($1,$2,$3,2,$4::text,'idempotent_with_key','provider-key',$5,case when $4::text='running' then clock_timestamp()+interval '1 minute' else null end,1,case when $4::text='succeeded' then clock_timestamp() else null end)`,
      [
        current,
        workspaceA,
        nodeId,
        currentStatus,
        currentStatus === 'running' ? 'retry-worker' : null,
      ],
    );
    await query(
      'update app.node_runs set current_attempt_id=$2,current_attempt_number=2 where id=$1',
      [nodeId, current],
    );
    const history = (
      await query('select * from app.node_attempts where id=$1', [prior])
    ).rows;
    const known = currentStatus === 'succeeded';
    const status = known ? 'failed' : 'outcome_unknown';
    expect(await f.fail()).toBe(status);
    expect(
      (
        await query('select status from app.workflow_runs where id=$1', [
          f.runId,
        ])
      ).rows,
    ).toEqual([{ status }]);
    expect(
      (await query('select status from app.node_runs where id=$1', [nodeId]))
        .rows,
    ).toEqual([{ status: known ? 'succeeded' : 'outcome_unknown' }]);
    expect(
      (
        await query(
          'select context from app.run_failure_notification_intents where workflow_run_id=$1',
          [f.runId],
        )
      ).rows,
    ).toEqual([
      {
        context: expect.objectContaining({
          terminalStatus: status,
          primaryFailure: expect.objectContaining({
            source: 'run',
            runStatus: status,
          }) as unknown,
        }) as unknown,
      },
    ]);
    expect(
      (await query('select * from app.node_attempts where id=$1', [prior]))
        .rows,
    ).toEqual(history);
    expect(
      (
        await query(
          'select status,dispatch_marked_at,lease_owner,lease_expires_at from app.node_attempts where id=$1',
          [current],
        )
      ).rows,
    ).toEqual([
      {
        status: known ? 'succeeded' : 'canceled',
        dispatch_marked_at: null,
        lease_owner: null,
        lease_expires_at: null,
      },
    ]);
  },
);
