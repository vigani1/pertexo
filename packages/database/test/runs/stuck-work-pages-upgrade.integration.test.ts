import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('adds bounded diagnostic access paths without rewriting retained deliveries or their authority', async () => {
  await withUpgradeDatabase(97, async ({ admin, upgrade }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    await admin.query(
      `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,available_at,published_at,failed_at,delivery_due_at)
      select gen_random_uuid(),$1,'advance-workflow-run','workflow-run',$2,jsonb_build_object('retained',n),repeat('a',64),
      clock_timestamp()-interval '1 day',case when n<=250 then clock_timestamp()-interval '1 hour' end,
      case when n>350 then clock_timestamp()-interval '1 hour' end,
      case when n between 251 and 350 then clock_timestamp()-interval '30 minutes' end
      from generate_series(1,400) n`,
      [workspaceId, workflowId],
    );
    const retained = () =>
      admin.query(
        `select to_jsonb(e) state from app.outbox_events e where workspace_id=$1 order by id`,
        [workspaceId],
      );
    const permissions = () =>
      admin.query(`select grantee,privilege_type,column_name from information_schema.column_privileges
      where table_schema='app' and table_name='outbox_events' order by grantee,privilege_type,column_name`);
    const before = await retained(),
      grants = await permissions();
    await upgrade(98);
    expect((await retained()).rows).toEqual(before.rows);
    expect((await permissions()).rows).toEqual(grants.rows);
    expect((await retained()).rows).toHaveLength(400);
  });
}, 60000);
