import { Client } from 'pg';
import { expect, it } from 'vitest';

import { enforceRetention } from '../../support/retention.js';
import { purgeWorkspace } from '../../support/workspace-purge.js';
import {
  adminUrl,
  maintenanceUrl,
  owner,
  seedPurgeScenario,
} from './fixture.js';

export function registerPurgesEveryWorkspaceTableKeeps(): void {
  it('purges every workspace table, keeps scrubbed facts and leaves a tombstone', async () => {
    if (owner === undefined) throw new Error('Owner pool unavailable');
    const { workspaceId, externalIntentId } = await seedPurgeScenario(owner);

    const steps = await purgeWorkspace({
      adminUrl,
      maintenanceUrl,
      workspaceId,
      pageSize: 1,
    });
    // Cycles go together, after everything that points at them.
    expect(steps).toContain('connections');
    expect(steps).toContain('connection_shares');
    expect(steps).toContain('connection_oauth2_tokens');
    expect(steps.indexOf('workflow_published_versions')).toBeLessThan(
      steps.indexOf('workflow_versions'),
    );

    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const tombstone = await admin.query(
        'select status,name,slug,created_by,deletion_reason from app.workspaces where id=$1',
        [workspaceId],
      );
      expect(tombstone.rows[0]).toEqual({
        status: 'deleted',
        name: 'Deleted workspace',
        slug: `deleted-${workspaceId}`,
        created_by: null,
        deletion_reason: 'purged',
      });
      const residue = await admin.query<Record<string, string>>(
        `select
          (select count(*) from app.workspace_memberships where workspace_id=$1) membership_count,
          (select count(*) from app.workspace_invitation_binding_replacement_claims
            where prior_workspace_id=$1 or successor_workspace_id=$1) replacement_claim_count,
          (select count(*) from app.artifacts where workspace_id=$1) artifact_count,
          (select count(*) from app.connection_oauth2_clients where workspace_id=$1)
            + (select count(*) from app.connection_oauth2_tokens where workspace_id=$1)
            + (select count(*) from app.connection_oauth2_authorizations where workspace_id=$1) oauth2_count,
          (select count(*) from app.audit_events where workspace_id=$1 and
            (actor_user_id is not null or request_id is not null or trace_id is not null
             or metadata<>'{}'::jsonb or target_id is distinct from $1)) audit_sensitive,
          (select count(*) from app.usage_events where workspace_id=$1 and
            (metadata<>'{}'::jsonb or resource_id<>$1
             or resource_type<>'workspace-tombstone' or idempotency_key<>id::text)) usage_sensitive,
          (select count(*) from app.transport_security_audit_facts where workspace_id=$1
            and (consumer_name<>'purged' or message_id<>id)) security_sensitive`,
        [workspaceId],
      );
      // A claim still live in another workspace waits for its own reaper.
      expect(residue.rows[0]).toEqual({
        audit_sensitive: '0',
        artifact_count: '0',
        membership_count: '0',
        oauth2_count: '0',
        replacement_claim_count: '1',
        security_sensitive: '0',
        usage_sensitive: '0',
      });
      await admin.query(
        `update app.workspace_invitation_acceptance_intents
            set status='superseded',updated_at=clock_timestamp()
          where id=$1`,
        [externalIntentId],
      );
      await enforceRetention(maintenanceUrl);
      const claims = await admin.query<{ count: string }>(
        `select count(*) from app.workspace_invitation_binding_replacement_claims
         where prior_workspace_id = $1 or successor_workspace_id = $1`,
        [workspaceId],
      );
      expect(claims.rows[0]?.count).toBe('0');
    } finally {
      await admin.end();
    }
  }, 30_000);
}
