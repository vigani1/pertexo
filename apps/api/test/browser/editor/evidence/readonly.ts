import type { Pool } from 'pg';
import { expect } from 'vitest';
import { z } from 'zod';

export const readonlySetupSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  ownerEmail: z.email(),
  viewerEmail: z.email(),
});
export const readonlyEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  viewerId: z.uuid(),
});
type Scope = z.infer<typeof readonlyEvidenceSchema>;

/** Non-secret, workspace-scoped durable facts, captured after owner authoring. */
async function readDurableState(database: Pool, scope: Scope) {
  const result = await database.query<{ state: unknown }>(
    `select jsonb_build_object(
       'draft', (select jsonb_build_object('revision',revision,'graph',graph_json,'updatedBy',updated_by)
                 from app.workflow_drafts where workspace_id=$1 and workflow_id=$2),
       'workflow', (select jsonb_build_object('name',name,'published',published_version_id,'status',lifecycle_status)
                    from app.workflows where workspace_id=$1 and id=$2),
       'versions', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'graph',graph_json,'checksum',checksum) order by id),'[]')
                    from app.workflow_versions where workspace_id=$1 and workflow_id=$2),
       'runs', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',workflow_version_id,'status',status) order by id),'[]')
                from app.workflow_runs where workspace_id=$1 and workflow_id=$2),
       'nodes', (select count(*) from app.node_runs where workspace_id=$1),
       'receipts', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'operation',operation,'status',status,'key',key_hash) order by id),'[]')
                    from app.idempotency_records where workspace_id=$1),
       'audits', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'action',action) order by id),'[]')
                  from app.audit_events where workspace_id=$1)
     ) as state`,
    [scope.workspaceId, scope.workflowId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]?.state;
}

/** Fixture-admin setup only; never installed on the application listener. */
export async function prepareReadonlyEvidence(
  database: Pool,
  input: z.infer<typeof readonlySetupSchema>,
) {
  const client = await database.connect();
  let viewerId: string;
  try {
    await client.query('begin');
    const identities = await client.query<{ id: string; email: string }>(
      `select id,email from app.users where email=any($1::text[])
       and email_verified=true and status='active' for update`,
      [[input.ownerEmail, input.viewerEmail]],
    );
    expect(identities.rows).toHaveLength(2);
    const ownerId = identities.rows.find(
      (user) => user.email === input.ownerEmail,
    )?.id;
    const viewer = identities.rows.find(
      (user) => user.email === input.viewerEmail,
    );
    if (ownerId === undefined || viewer === undefined)
      throw new Error('Ordinarily verified fixture identities missing');
    viewerId = viewer.id;
    const owned = await client.query(
      `select workflow.id from app.workflows workflow
       join app.workspace_memberships membership on membership.workspace_id=workflow.workspace_id
       join app.workspaces workspace on workspace.id=workflow.workspace_id
       where workflow.id=$1 and workflow.workspace_id=$2 and workflow.created_by=$3
       and membership.user_id=$3 and membership.role='owner' and membership.status='active'
       and workspace.status='active'`,
      [input.workflowId, input.workspaceId, ownerId],
    );
    expect(owned.rows).toHaveLength(1);
    await client.query(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status)
       values($1,$2,'viewer','active')`,
      [input.workspaceId, viewerId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  const scope = {
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    viewerId,
  };
  const before = await readDurableState(database, scope);
  return {
    scope,
    async verify(evidence: Scope) {
      expect(evidence).toEqual(scope);
      expect(await readDurableState(database, scope)).toEqual(before);
      const member = await database.query(
        `select role,status from app.workspace_memberships where workspace_id=$1 and user_id=$2`,
        [scope.workspaceId, scope.viewerId],
      );
      expect(member.rows).toEqual([{ role: 'viewer', status: 'active' }]);
      const sessions = await database.query<{ count: number }>(
        'select count(*)::int as count from app.auth_sessions where user_id=$1 and expires_at>clock_timestamp()',
        [scope.viewerId],
      );
      expect(sessions.rows[0]?.count).toBeGreaterThan(0);
    },
  };
}
