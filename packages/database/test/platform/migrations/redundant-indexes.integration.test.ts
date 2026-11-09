import { expect, it } from 'vitest';
import { seedWorkflow, withDatabase } from './upgrade-fixture.js';

it('removes redundant organization indexes without losing populated links or their indexed lookup', async () => {
  await withDatabase(async ({ admin }) => {
    const { workspaceId } = await seedWorkflow(admin);
    await admin.query(
      `insert into app.auth_organizations(id,control_workspace_id,name) values($1,$1,'Retained organization')`,
      [workspaceId],
    );
    await admin.query(
      `insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$1)`,
      [workspaceId],
    );

    expect(
      (
        await admin.query(
          `select workspace_id from app.auth_organization_workspaces where organization_id=$1`,
          [workspaceId],
        )
      ).rows,
    ).toEqual([{ workspace_id: workspaceId }]);
    expect(
      (
        await admin.query(
          `select indexname from pg_indexes where schemaname='app' and indexname in ('auth_organization_workspace_org_idx','auth_provider_organization_idx','failure_notification_destination_versions_workspace_idx','transport_security_audit_facts_workspace_time_idx')`,
        )
      ).rows,
    ).toEqual([]);
    await admin.query('set enable_seqscan=off');
    for (const query of [
      `select version from app.failure_notification_destination_versions where workspace_id=$1 and destination_id=$1 order by version desc limit 50`,
      `select id from app.transport_security_audit_facts where workspace_id=$1 order by occurred_at desc limit 50`,
    ]) {
      const ordered = await admin.query(`explain ${query}`, [workspaceId]);
      expect(JSON.stringify(ordered.rows)).toContain(
        'Index Only Scan Backward',
      );
      expect(JSON.stringify(ordered.rows)).not.toContain('Sort');
    }
    const plan = await admin.query(
      `explain select workspace_id from app.auth_organization_workspaces where organization_id=$1`,
      [workspaceId],
    );
    expect(JSON.stringify(plan.rows)).toContain(
      'auth_organization_workspace_identity_unique',
    );
  });
}, 60_000);
