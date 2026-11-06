import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { expect, it } from 'vitest';
import { createCheckpoint } from '@pertexo/workflow-engine/server';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

async function upgradedTimers(
  work: (fixture: {
    scoped: <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
    activeId: string;
    parkedId: string;
    counts: () => Promise<readonly { stored: number; actual: number }[]>;
  }) => Promise<void>,
  drift?: 'park' | 'resume',
) {
  await withUpgradeDatabase(100, async ({ admin, config, upgrade }) => {
    const { ownerId, workspaceId, workflowId } = await seedWorkflow(admin);
    await admin.query('select app.apply_instance_capacity(1,100,1000)');
    const versionId = randomUUID(),
      activeId = randomUUID(),
      parkedId = randomUUID();
    await admin.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by)
      values($1,$2,$3,1,'{}','{}',$4,$5)`,
      [
        versionId,
        workspaceId,
        workflowId,
        'wf:sha256:' + 'a'.repeat(64),
        ownerId,
      ],
    );
    const url = new URL(
      process.env.DATABASE_URL ??
        'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
    );
    url.pathname = new URL(config.connectionString).pathname;
    const app = new Pool({ connectionString: url.toString(), max: 1 });
    const scoped = async <T>(
      operation: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      const client = await app.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const result = await operation(client);
        await client.query('commit');
        return result;
      } catch (error: unknown) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    };
    try {
      await scoped(async (client) => {
        for (const id of [activeId, parkedId]) {
          const key = `${versionId}|timer|b:|i:`;
          await client.query(
            `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,timed_wait_started_at)
            values($1,$2,$3,$4,'api','waiting',case when $5 then clock_timestamp() end)`,
            [id, workspaceId, workflowId, versionId, id === parkedId],
          );
          const state = {
            ...createCheckpoint({
              workflowVersionId: versionId,
              iterationBudget: 200,
              nextEventSequence: 2,
            }),
            runStatus: 'waiting',
            invocations: [
              {
                invocationKey: key,
                nodeId: 'timer',
                status: 'waiting',
                waitKind: 'node_wait',
                attemptNumber: 0,
                resumeAt: '2099-01-01T00:00:00.000Z',
              },
            ],
          };
          await client.query(
            'insert into app.run_checkpoints(workspace_id,workflow_run_id,workflow_version_id,revision,scheduler_state) values($1,$2,$3,0,$4)',
            [workspaceId, id, versionId, state],
          );
          await client.query(
            `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,wait_kind,resume_at)
            values($1,$2,$3,'timer',$4,'{}','waiting','safe','node_wait','2099-01-01')`,
            [randomUUID(), workspaceId, id, key],
          );
          await client.query(
            "insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload) values($1,$2,1,'run.waiting','{}')",
            [workspaceId, id],
          );
        }
      });
      if (drift !== undefined) {
        await scoped((client) =>
          client.query(
            'update app.workflow_runs set timed_wait_started_at=case when $2 then clock_timestamp() end where id=$1',
            [drift === 'park' ? activeId : parkedId, drift === 'park'],
          ),
        );
        await upgrade(101);
        const stale = await scoped((client) =>
          client.query<{ stored: number; actual: number }>(
            `select counter.active_runs stored,slots.active_runs actual from app.workspace_execution_admission_counters counter
           cross join lateral app.workflow_run_slot_counts(counter.workspace_id) slots where counter.workspace_id=$1`,
            [workspaceId],
          ),
        );
        expect(stale.rows).toEqual([
          { stored: 1, actual: drift === 'park' ? 0 : 2 },
        ]);
      }
      const retained = async () => {
        const data: unknown[] = [];
        for (const table of [
          'workflow_runs',
          'node_runs',
          'run_checkpoints',
          'run_events',
          ...(drift === undefined
            ? ['workspace_execution_admission_counters']
            : []),
        ])
          data.push(
            (
              await admin.query(
                `select to_jsonb(row) state from app.${table} row where workspace_id=$1 order by to_jsonb(row)::text`,
                [workspaceId],
              )
            ).rows,
          );
        return data;
      };
      const before = await retained();
      await upgrade();
      expect(await retained()).toEqual(before);
      expect(await upgrade()).toEqual([]);
      const counts = () =>
        scoped(
          async (client) =>
            (
              await client.query<{ stored: number; actual: number }>(
                `select counter.active_runs stored,slots.active_runs actual from app.workspace_execution_admission_counters counter
        cross join lateral app.workflow_run_slot_counts(counter.workspace_id) slots where counter.workspace_id=$1`,
                [workspaceId],
              )
            ).rows,
        );
      let expected = 1;
      if (drift === 'park') expected = 0;
      if (drift === 'resume') expected = 2;
      expect(await counts()).toEqual([{ stored: expected, actual: expected }]);
      await work({ scoped, activeId, parkedId, counts });
    } finally {
      await app.end();
    }
  });
}

it.each(['park', 'resume'] as const)(
  'keeps counters correct for a timer-only %s after a populated upgrade',
  async (transition) => {
    await upgradedTimers(async ({ scoped, activeId, parkedId, counts }) => {
      if (transition === 'park') {
        await scoped((client) =>
          client.query(
            'update app.workflow_runs set timed_wait_started_at=clock_timestamp() where id=$1',
            [activeId],
          ),
        );
        expect(await counts()).toEqual([{ stored: 0, actual: 0 }]);
      } else {
        await scoped((client) =>
          client.query(
            "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp() where id=$1",
            [activeId],
          ),
        );
        expect(await counts()).toEqual([{ stored: 0, actual: 0 }]);
        await scoped((client) =>
          client.query(
            'update app.workflow_runs set timed_wait_started_at=null where id=$1',
            [parkedId],
          ),
        );
        expect(await counts()).toEqual([{ stored: 1, actual: 1 }]);
      }
    });
  },
  60000,
);

it('rejects a timer-only resume past capacity after a populated upgrade, then resumes when a slot is free', async () => {
  await upgradedTimers(async ({ scoped, activeId, parkedId, counts }) => {
    await expect(
      scoped((client) =>
        client.query(
          'update app.workflow_runs set timed_wait_started_at=null where id=$1',
          [parkedId],
        ),
      ),
    ).rejects.toMatchObject({ code: 'PTA03' });
    expect(await counts()).toEqual([{ stored: 1, actual: 1 }]);
    expect(
      await scoped(
        async (client) =>
          (
            await client.query<{ parked: boolean }>(
              'select timed_wait_started_at is not null parked from app.workflow_runs where id=$1',
              [parkedId],
            )
          ).rows,
      ),
    ).toEqual([{ parked: true }]);
    await scoped((client) =>
      client.query(
        "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp() where id=$1",
        [activeId],
      ),
    );
    await scoped((client) =>
      client.query(
        'update app.workflow_runs set timed_wait_started_at=null where id=$1',
        [parkedId],
      ),
    );
    expect(await counts()).toEqual([{ stored: 1, actual: 1 }]);
  });
}, 60000);

it.each(['park', 'resume'] as const)(
  'recomputes counters already damaged by timer-only %s under 0100 without changing durable run evidence',
  async (drift) => {
    await upgradedTimers(async ({ counts }) => {
      const expected = drift === 'park' ? 0 : 2;
      expect(await counts()).toEqual([{ stored: expected, actual: expected }]);
    }, drift);
  },
  60_000,
);
