import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  checkpoints,
  events,
  nodeDetails,
} from '../../src/lifecycle/retention/rules/run-records.repository.js';
import { workspaceId } from './retention.support.js';
import { admin, untilIdle } from './retention-runs/fixture.js';

describe('an idle pass', () => {
  // The audit's finding: walking a child table and probing each row's run read
  // all of it when nothing was due. A tenth of the rows is well above what
  // finding no due run reads, and far below walking the table.
  it.each([
    ['node_runs', nodeDetails],
    ['run_events', events],
    ['run_checkpoints', checkpoints],
  ] as const)(
    'reads under a tenth of %s when nothing is due',
    async (table, rule) => {
      await untilIdle();
      const rows = 2_000;
      await admin.query(
        `with runs as (
           insert into app.workflow_runs
             (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
              started_at,completed_at,created_at,updated_at)
           select gen_random_uuid(),$1,gen_random_uuid(),$3::uuid,'manual',
             'succeeded',clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp()
           from generate_series(1,$2::int)
           returning id
         ), steps as (
           insert into app.node_runs
             (id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
              status,side_effect_class)
           select gen_random_uuid(),$1,id,'node','node','{}','succeeded','safe' from runs
         ), history as (
           insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
           select $1,id,1,'run.succeeded','{}' from runs
         )
         insert into app.run_checkpoints
           (workflow_run_id,workspace_id,workflow_version_id,revision,scheduler_state)
         select id,$1,$3::uuid,1,'{}' from runs`,
        [workspaceId, rows, randomUUID()],
      );
      await admin.query(
        'analyze app.workflow_runs, app.node_runs, app.run_events, app.run_checkpoints',
      );
      await admin.query('begin');
      try {
        expect(await rule.run(admin as never, 500)).toBe(0);
        const read = await admin.query<{ tuples: number }>(
          `select (coalesce(seq_tup_read,0)+coalesce(idx_tup_fetch,0))::int tuples
             from pg_stat_xact_user_tables
            where schemaname='app' and relname=$1`,
          [table],
        );
        expect(read.rows[0]?.tuples).toBeLessThan(rows / 10);
      } finally {
        await admin.query('rollback');
      }
    },
    60_000,
  );
});
