import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { workspaceA } from '../run-store.fixture.js';
import { emergencyRun, query } from './emergency.fixture.js';

it.each(['human_task', 'workflow_call', 'for_each_barrier'] as const)(
  'physically closes an emergency %s wait and clears logical-control fields',
  async (controlKind) => {
    const f = await emergencyRun();
    const nodeId = randomUUID();
    await query(
      "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,control_kind,resume_at) values($1,$2,$3,'wait','wait','waiting','safe',$4::varchar,case when $4::varchar='human_task' then clock_timestamp()+interval '1 day' else null end)",
      [nodeId, workspaceA, f.runId, controlKind],
    );
    await expect(f.fail()).resolves.toBe('failed');
    const nodes = await query(
      'select status,control_kind,wait_kind,resume_at,retry_due_at,due_wakeup_at,completed_at from app.node_runs where id=$1',
      [nodeId],
    );
    expect(nodes.rows).toEqual([
      {
        status: 'canceled',
        control_kind: null,
        wait_kind: null,
        resume_at: null,
        retry_due_at: null,
        due_wakeup_at: null,
        completed_at: expect.any(Date) as unknown,
      },
    ]);
    const run = await query(
      'select status,completed_at from app.workflow_runs where id=$1',
      [f.runId],
    );
    expect(run.rows).toEqual([
      { status: 'failed', completed_at: expect.any(Date) as unknown },
    ]);
  },
);
