import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { IdempotencyRequestConflictError } from '../../../src/runs/commands/acceptance/errors.js';

import { WorkflowPublishedVersionConflictError } from '../../../src/runs/errors.js';

import {
  explainDocument,
  explainWork,
} from '../../support/postgres/query-plan.js';

import {
  adminUrl,
  disposableDatabase,
  workspaceId,
  actorId,
  workflowId,
  retainedWorkflowVersionId,
  database,
  digest,
  startInput,
  ownerQuery,
  apiQuery,
} from './fixture.js';

export function registerRecordsProductionShapedNameFilter(): void {
  it('records production-shaped name-filter work under normal planner settings', async () => {
    await ownerQuery(
      `insert into app.workflows
         (id, workspace_id, name, lifecycle_status, activation_status, created_by)
       select gen_random_uuid(), $1,
              case
                when ordinal <= 20 then 'Common workflow ' || ordinal
                when ordinal = 21 then 'Selective needle'
                else 'Other workflow ' || ordinal
              end,
              'active', 'inactive', $2
       from generate_series(1, 40) ordinal`,
      [workspaceId, actorId],
    );
    await ownerQuery(
      `insert into app.workflow_versions
         (id, workspace_id, workflow_id, version_number, graph_json, checksum, executable_json, published_by)
       select gen_random_uuid(), $1, workflow.id, 1,
              '{"nodes":[],"edges":[],"settings":{}}'::jsonb,
              'wf:sha256:' || repeat('d', 64),
              '{}'::jsonb, $2
        from app.workflows workflow
       where workflow.workspace_id = $1
         and workflow.name similar to '(Common|Selective|Other)%'`,
      [workspaceId, actorId],
    );
    // This test measures read plans, not run admission. Seed terminal history
    // with the disposable database admin so the per-row admission recount does
    // not consume the test's fixed 15-second budget before EXPLAIN runs.
    // The disabled trigger normally allocates mandatory admission tickets, so
    // only this privileged historical seed uses the private sequence directly.
    const fixtureAdmin = new Pool({
      connectionString: disposableDatabase.databaseUrl(adminUrl),
      max: 1,
    });
    try {
      const seedClient = await fixtureAdmin.connect();
      try {
        await seedClient.query('begin');
        await seedClient.query(
          'alter table app.workflow_runs disable trigger workflow_runs_execution_admission',
        );
        await seedClient.query(
          'alter table app.workflow_runs disable trigger workflow_runs_refresh_execution_admission',
        );
        await seedClient.query(
          `insert into app.workflow_runs
         (id, workspace_id, workflow_id, workflow_version_id,
          trigger_type, status, execution_entitlement_version, admission_ticket,
          created_at, updated_at)
       select gen_random_uuid(), $1, workflow.id, version.id, 'manual',
              case when run_number % 2 = 0 then 'failed' else 'succeeded' end,
              1,
              nextval('app.workflow_run_admission_ticket_seq'),
              '2026-09-01T00:00:00Z'::timestamptz
                + ((row_number() over ())::text || ' milliseconds')::interval,
              '2026-09-01T00:00:00Z'::timestamptz
                + ((row_number() over ())::text || ' milliseconds')::interval
       from app.workflows workflow
       join app.workflow_versions version
         on version.workspace_id = workflow.workspace_id
        and version.workflow_id = workflow.id
       cross join generate_series(1, 250) run_number
       where workflow.workspace_id = $1
         and workflow.name similar to '(Common|Selective|Other)%'`,
          [workspaceId],
        );
        await seedClient.query(
          'alter table app.workflow_runs enable trigger workflow_runs_refresh_execution_admission',
        );
        await seedClient.query(
          'alter table app.workflow_runs enable trigger workflow_runs_execution_admission',
        );
        await seedClient.query('commit');
        const triggers = await seedClient.query<{
          tgname: string;
          tgenabled: string;
        }>(
          `select tgname,tgenabled from pg_trigger
            where tgrelid='app.workflow_runs'::regclass
              and tgname in ('workflow_runs_execution_admission',
                             'workflow_runs_refresh_execution_admission')
            order by tgname`,
        );
        expect(triggers.rows).toEqual([
          { tgname: 'workflow_runs_execution_admission', tgenabled: 'O' },
          {
            tgname: 'workflow_runs_refresh_execution_admission',
            tgenabled: 'O',
          },
        ]);
      } catch (error) {
        await seedClient.query('rollback');
        throw error;
      } finally {
        seedClient.release();
      }
    } finally {
      await fixtureAdmin.end();
    }
    const cardinality = await apiQuery<{ workflows: number; runs: number }>(
      `select count(distinct workflow_id)::integer workflows,
              count(*)::integer runs
         from app.workflow_runs where workspace_id=$1
           and created_at >= '2026-09-01T00:00:00Z'::timestamptz`,
      [workspaceId],
    );
    expect(cardinality.rows[0]).toEqual({ workflows: 40, runs: 10_000 });
    await ownerQuery('analyze app.workflows');
    await ownerQuery('analyze app.workflow_runs');

    const explain = async (
      prefix: string | null,
      status: string | null,
      after: string | null,
    ) =>
      explainDocument(
        await apiQuery(
          `explain (analyze, buffers, settings, format json)
           select run.id
           from app.workflow_runs run
           left join app.workflows workflow
             on workflow.workspace_id = run.workspace_id
            and workflow.id = run.workflow_id
           where run.workspace_id = $1
             and ($2::text is null
               or lower(workflow.name) like lower($2::text) || '%' escape '\\')
             and ($3::text is null or run.status = $3::text)
             and ($4::timestamptz is null
               or run.created_at < $4::timestamptz
               or (run.created_at = $4::timestamptz and run.id < $5::uuid))
           order by run.created_at desc, run.id desc
           limit 50`,
          [
            workspaceId,
            prefix,
            status,
            after,
            after === null ? null : 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          ],
        ),
      );

    const evidence = {
      absent: await explain(null, null, null),
      selective: await explain('Selective', null, null),
      common: await explain('Common', null, null),
      noMatch: await explain('Missing', null, null),
      combined: await explain('Common', 'failed', null),
      deep: await explain('Common', null, '2026-09-01T00:00:02.500000Z'),
    };
    expect(evidence.absent.Plan['Actual Rows']).toBe(50);
    expect(evidence.selective.Plan['Actual Rows']).toBe(50);
    expect(evidence.common.Plan['Actual Rows']).toBe(50);
    expect(evidence.noMatch.Plan['Actual Rows']).toBe(0);
    expect(evidence.combined.Plan['Actual Rows']).toBe(50);
    expect(evidence.deep.Plan['Actual Rows']).toBe(50);
    const measured = Object.fromEntries(
      Object.entries(evidence).map(([scenario, plan]) => [
        scenario,
        {
          ...explainWork(plan.Plan),
          executionTimeMs: plan['Execution Time'],
        },
      ]),
    );
    for (const [scenario, plan] of Object.entries(evidence)) {
      expect(plan.Settings?.enable_seqscan).not.toBe('off');
      expect(measured[scenario]?.summedNodeRowWork).toBeGreaterThan(0);
      expect(measured[scenario]?.rootSharedBufferTouches).toBeGreaterThan(0);
      expect(measured[scenario]?.nodeTypes.length).toBeGreaterThan(0);
    }
    expect(measured.noMatch?.outputRowInstances).toBe(0);
    expect(measured.noMatch?.rejectedRowInstances).toBeGreaterThan(0);
  }, 15_000);

  it('commits a stale rejection, preserves it after republication, and conflicts on changed intent', async () => {
    const input = {
      ...startInput(),
      expectedPublishedVersionId: retainedWorkflowVersionId,
    };
    await expect(database.start(input)).rejects.toBeInstanceOf(
      WorkflowPublishedVersionConflictError,
    );
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, retainedWorkflowVersionId],
    );
    await expect(database.start(input)).rejects.toBeInstanceOf(
      WorkflowPublishedVersionConflictError,
    );
    await expect(
      database.start({ ...input, requestHash: digest('changed-intent') }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    const effects = await ownerQuery(`select
      (select count(*)::int from app.workflow_runs) runs,
      (select count(*)::int from app.run_checkpoints) checkpoints,
      (select count(*)::int from app.outbox_events) outbox,
      (select count(*)::int from app.workflow_manual_start_rejections) rejections`);
    expect(effects.rows).toEqual([
      { runs: 0, checkpoints: 0, outbox: 0, rejections: 1 },
    ]);
  });
}
