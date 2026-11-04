import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { expect, it } from 'vitest';
import { createCheckpoint } from '@pertexo/workflow-engine';
import { canonicalOutboxPayloadChecksum } from '../../src/primitives.js';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('retains populated run pins, receipts and reservations, and keeps SQL capacity atomic after policy moves to core', async () => {
  await withUpgradeDatabase(99, async ({ admin, config, upgrade }) => {
    const { ownerId, workspaceId, workflowId } = await seedWorkflow(admin);
    const versionId = randomUUID(),
      activeId = randomUUID(),
      firstId = randomUUID(),
      secondId = randomUUID();
    const deliveries = new Map<string, string>();
    const holder = await admin.connect();
    try {
      await holder.query('select app.apply_instance_capacity(2,2,1000)');
      await holder.query(
        `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
        values($1,$2,$3,1,'{"settings":{},"nodes":[],"edges":[]}',$4,'{}',$5)`,
        [
          versionId,
          workspaceId,
          workflowId,
          `wf:sha256:${'a'.repeat(64)}`,
          ownerId,
        ],
      );
      await holder.query('begin');
      await holder.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      for (const [id, status] of [
        [activeId, 'running'],
        [firstId, 'queued'],
        [secondId, 'queued'],
      ] as const) {
        await holder.query(
          `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,status,trigger_type,started_at)
          values($1,$2,$3,$4,$5::varchar,'api',case when $5::varchar='running' then clock_timestamp() end)`,
          [id, workspaceId, workflowId, versionId, status],
        );
        const running = status === 'running',
          revision = running ? 1 : 0;
        const checkpoint = {
          ...createCheckpoint({
            workflowVersionId: versionId,
            iterationBudget: 200,
            nextEventSequence: running ? 3 : 2,
          }),
          revision,
          runStatus: status,
        };
        await holder.query(
          'insert into app.run_checkpoints(workspace_id,workflow_run_id,workflow_version_id,revision,scheduler_state) values($1,$2,$3,$4,$5)',
          [workspaceId, id, versionId, revision, checkpoint],
        );
        await holder.query(
          "insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload) values($1,$2,1,'run.queued','{}')",
          [workspaceId, id],
        );
        if (running)
          await holder.query(
            "insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload) values($1,$2,2,'run.started','{}')",
            [workspaceId, id],
          );
        const outboxEventId = randomUUID(),
          payload = { workspaceId, runId: id, outboxEventId };
        deliveries.set(id, outboxEventId);
        await holder.query(
          `insert into app.outbox_events(id,workspace_id,aggregate_type,aggregate_id,job_name,payload,payload_checksum,published_at)
          values($1,$2,'workflow-run',$3,'advance-workflow-run',$4,$5,case when $6::boolean then clock_timestamp() end)`,
          [
            outboxEventId,
            workspaceId,
            id,
            payload,
            canonicalOutboxPayloadChecksum(payload),
            running,
          ],
        );
        if (running)
          await holder.query(
            `insert into app.inbox_receipts(consumer_name,message_id,workspace_id,payload_checksum,completed_at)
          values('workflow-coordinator',$1,$2,$3,clock_timestamp())`,
            [
              outboxEventId,
              workspaceId,
              canonicalOutboxPayloadChecksum(payload),
            ],
          );
      }
      expect(
        (
          await holder.query(
            'select app.reserve_workflow_run_active_admission($1,$2,$3) reserved',
            [workspaceId, deliveries.get(firstId), firstId],
          )
        ).rows,
      ).toEqual([{ reserved: true }]);
      await holder.query('commit');
      const retained = async () => {
        const rows: unknown[] = [];
        for (const table of [
          'workflow_runs',
          'run_checkpoints',
          'run_events',
          'outbox_events',
          'inbox_receipts',
          'workflow_run_active_admissions',
          'workspace_execution_admission_counters',
        ])
          rows.push(
            (
              await holder.query(
                `select to_jsonb(row) state from app.${table} row where workspace_id=$1 order by to_jsonb(row)::text`,
                [workspaceId],
              )
            ).rows,
          );
        return rows;
      };
      const before = await retained();
      const grants = async () =>
        (
          await holder.query<{
            table_name: string;
            column_name: string;
            grantee: string;
            privilege_type: string;
          }>(`select table_name,column_name,grantee,privilege_type from information_schema.column_privileges
        where table_schema='app' and table_name in ('workflow_runs','workspace_execution_entitlements','workspace_execution_entitlement_versions','workspace_execution_admission_counters')
        order by table_name,column_name,grantee,privilege_type`)
        ).rows;
      const authority = await grants();
      await upgrade(100);
      expect(await retained()).toEqual(before);
      expect(await grants()).toEqual(authority);

      const url = new URL(
        process.env.DATABASE_URL ??
          'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
      );
      url.pathname = new URL(config.connectionString).pathname;
      const app = new Pool({ connectionString: url.toString(), max: 2 });
      const insert = (client: PoolClient, id: string, status = 'queued') =>
        client.query(
          `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
        values($1,$2,$3,$4,'api',$5)`,
          [id, workspaceId, workflowId, versionId, status],
        );
      const scoped = async <T>(
        work: (client: PoolClient) => Promise<T>,
      ): Promise<T> => {
        const client = await app.connect();
        try {
          await client.query('begin');
          await client.query("select set_config('app.workspace_id',$1,true)", [
            workspaceId,
          ]);
          const result = await work(client);
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
        await expect(
          scoped((client) => insert(client, randomUUID())),
        ).rejects.toMatchObject({ code: 'PTA02' });
        await expect(
          scoped((client) => insert(client, randomUUID(), 'running')),
        ).rejects.toMatchObject({ code: 'PTA03' });
        await expect(
          scoped((client) =>
            client.query(
              "update app.workspace_execution_entitlement_versions set status='suspended' where workspace_id=$1",
              [workspaceId],
            ),
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          scoped((client) =>
            client.query(
              'update app.workspace_execution_admission_counters set active_runs=0 where workspace_id=$1',
              [workspaceId],
            ),
          ),
        ).rejects.toMatchObject({ code: '42501' });
        const counters = async () =>
          (
            await holder.query<{
              active_runs: number;
              queued_runs: number;
              reserved_active_slots: number;
            }>(
              `select active_runs,queued_runs,(select count(*)::int from app.workflow_run_active_admissions where workspace_id=$1) reserved_active_slots from app.workspace_execution_admission_counters where workspace_id=$1`,
              [workspaceId],
            )
          ).rows;
        expect(await counters()).toEqual([
          { active_runs: 1, reserved_active_slots: 1, queued_runs: 2 },
        ]);
        await scoped((client) =>
          client.query(
            "update app.workflow_runs set status='running' where id=$1",
            [firstId],
          ),
        );
        expect(await counters()).toEqual([
          { active_runs: 2, reserved_active_slots: 0, queued_runs: 1 },
        ]);
        await scoped((client) =>
          client.query(
            "update app.workflow_runs set status='running' where id=$1",
            [firstId],
          ),
        );
        expect(await counters()).toEqual([
          { active_runs: 2, reserved_active_slots: 0, queued_runs: 1 },
        ]);

        // Bypass core's early counter lock: this proves the retained SQL fence,
        // rather than accidentally testing TypeScript serialization twice.
        const a = await app.connect(),
          b = await app.connect();
        let pending: Promise<unknown> | undefined;
        try {
          for (const client of [a, b]) {
            await client.query('begin');
            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [workspaceId],
            );
          }
          const aPid = (
            await a.query<{ pid: number }>('select pg_backend_pid() pid')
          ).rows[0]?.pid;
          const bPid = (
            await b.query<{ pid: number }>('select pg_backend_pid() pid')
          ).rows[0]?.pid;
          await insert(a, randomUUID());
          pending = insert(b, randomUUID());
          const observed = pending.then(
            (value) => value,
            (error: unknown) => error,
          );
          await expect
            .poll(
              async () =>
                (
                  await holder.query<{ blocked: boolean }>(
                    'select $1::int=any(pg_blocking_pids($2::int)) blocked',
                    [aPid, bPid],
                  )
                ).rows[0]?.blocked,
              { timeout: 2000, interval: 10 },
            )
            .toBe(true);
          await a.query('commit');
          expect(await observed).toMatchObject({ code: 'PTA02' });
          await b.query('rollback');
          expect(await counters()).toEqual([
            { active_runs: 2, reserved_active_slots: 0, queued_runs: 2 },
          ]);
        } finally {
          await a.query('rollback');
          await b.query('rollback');
          if (pending !== undefined) await Promise.allSettled([pending]);
          a.release();
          b.release();
        }
      } finally {
        await app.end();
      }
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });
}, 60000);
