import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { useIdentityCommandDatabase } from './support/identity-command.integration.support.js';

// Deliberately unrun in the no-service foundation pass. Require explicit
// disposable-environment URLs rather than silently using local defaults.
const configured = [
  'DATABASE_ADMIN_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_API_URL',
  'DATABASE_WORKER_URL',
].every((name) => Boolean(process.env[name]));

describe.skipIf(!configured)(
  'workspace inbox foundation with real runtime-role RLS',
  () => {
    const database = useIdentityCommandDatabase('workspace_inbox');

    async function seed() {
      const owner = await database.user('Inbox owner');
      const operator = await database.user('Inbox operator');
      const viewer = await database.user('Inbox viewer');
      const workspaceId = await database.workspace(owner.id);
      await database.member(workspaceId, operator.id, 'operator');
      await database.member(workspaceId, viewer.id, 'viewer');
      const runId = randomUUID();
      const sourceId = randomUUID();
      const ownerEntry = randomUUID();
      const operatorEntry = randomUUID();
      await asRuntime(
        workspaceId,
        owner.id,
        'pertexo_api',
        `INSERT INTO app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
      VALUES($1,$2,$3,$4,'manual','failed')`,
        [runId, workspaceId, randomUUID(), randomUUID()],
      );
      await database.asAdmin(
        `INSERT INTO app.workspace_inbox_sources
      (id,workspace_id,run_id,terminal_event_sequence,kind,checksum,occurred_at,expires_at,evidence_until,status,captured_at,audience_count)
      VALUES($1,$2,$3,1,'failed',repeat('a',64),statement_timestamp(),statement_timestamp()+interval '720 hours',
      statement_timestamp()+interval '2160 hours','captured',statement_timestamp(),2)`,
        [sourceId, workspaceId, runId],
      );
      for (const [userId, entryId] of [
        [owner.id, ownerEntry],
        [operator.id, operatorEntry],
      ]) {
        await database.asAdmin(
          `INSERT INTO app.workspace_inbox_audience(workspace_id,source_id,user_id,observed_role_revision)
        VALUES($1,$2,$3,1)`,
          [workspaceId, sourceId, userId],
        );
        await database.asAdmin(
          `INSERT INTO app.workspace_inbox_recipient_state(workspace_id,user_id,revision) VALUES($1,$2,1)`,
          [workspaceId, userId],
        );
        await database.asAdmin(
          `INSERT INTO app.workspace_inbox_entries(id,workspace_id,source_id,user_id,creation_revision,created_at,expires_at)
        VALUES($1,$2,$3,$4,1,statement_timestamp(),statement_timestamp()+interval '720 hours')`,
          [entryId, workspaceId, sourceId, userId],
        );
      }
      return {
        workspaceId,
        owner,
        operator,
        viewer,
        sourceId,
        runId,
        ownerEntry,
        operatorEntry,
      };
    }

    async function asRuntime(
      workspaceId: string,
      userId: string,
      role: 'pertexo_api' | 'pertexo_worker' | 'pertexo_maintenance',
      statement: string,
      values: unknown[] = [],
    ) {
      await database.asAdmin('BEGIN');
      try {
        // Role names are fixed test constants, not request-controlled identifiers.
        await database.asAdmin(`SET LOCAL ROLE ${role}`);
        await database.asAdmin(
          `SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)`,
          [workspaceId, userId],
        );
        const rows = await database.asAdmin(statement, values);
        await database.asAdmin('COMMIT');
        return rows;
      } catch (error: unknown) {
        await database.asAdmin('ROLLBACK');
        throw error;
      }
    }

    it('isolates recipients and tenants, omits data without actor context', async () => {
      const fixture = await seed();
      const other = await database.workspace(fixture.owner.id);
      const select = 'SELECT id FROM app.workspace_inbox_entries';
      await expect(
        asRuntime(fixture.workspaceId, fixture.owner.id, 'pertexo_api', select),
      ).resolves.toEqual([{ id: fixture.ownerEntry }]);
      await expect(
        asRuntime(
          fixture.workspaceId,
          fixture.operator.id,
          'pertexo_api',
          select,
        ),
      ).resolves.toEqual([{ id: fixture.operatorEntry }]);
      await expect(
        asRuntime(other, fixture.owner.id, 'pertexo_api', select),
      ).resolves.toEqual([]);
      await expect(
        asRuntime(fixture.workspaceId, '', 'pertexo_api', select),
      ).resolves.toEqual([]);
      await expect(
        asRuntime(
          fixture.workspaceId,
          fixture.viewer.id,
          'pertexo_api',
          select,
        ),
      ).resolves.toEqual([]);
    });

    it('rechecks active workspace, membership and user while retaining evidence', async () => {
      const fixture = await seed();
      const select = 'SELECT id FROM app.workspace_inbox_entries';
      await database.asAdmin(
        "UPDATE app.users SET status='suspended' WHERE id=$1",
        [fixture.operator.id],
      );
      await expect(
        asRuntime(
          fixture.workspaceId,
          fixture.operator.id,
          'pertexo_api',
          select,
        ),
      ).resolves.toEqual([]);
      await database.asAdmin(
        "UPDATE app.users SET status='active' WHERE id=$1",
        [fixture.operator.id],
      );
      await database.asAdmin(
        "UPDATE app.workspace_memberships SET status='suspended' WHERE workspace_id=$1 AND user_id=$2",
        [fixture.workspaceId, fixture.operator.id],
      );
      await expect(
        asRuntime(
          fixture.workspaceId,
          fixture.operator.id,
          'pertexo_api',
          select,
        ),
      ).resolves.toEqual([]);
      await database.asAdmin(
        "UPDATE app.workspace_memberships SET status='active' WHERE workspace_id=$1 AND user_id=$2",
        [fixture.workspaceId, fixture.operator.id],
      );
      await expect(
        asRuntime(
          fixture.workspaceId,
          fixture.operator.id,
          'pertexo_api',
          select,
        ),
      ).resolves.toEqual([{ id: fixture.operatorEntry }]);
      await database.asAdmin(
        "UPDATE app.workspaces SET status='suspended' WHERE id=$1",
        [fixture.workspaceId],
      );
      await expect(
        asRuntime(
          fixture.workspaceId,
          fixture.operator.id,
          'pertexo_api',
          select,
        ),
      ).resolves.toEqual([]);
      await expect(
        database.asAdmin(
          'SELECT id FROM app.workspace_inbox_entries WHERE workspace_id=$1',
          [fixture.workspaceId],
        ),
      ).resolves.toHaveLength(2);
    });

    it('hides expired retained evidence without physically deleting it', async () => {
      const fixture = await seed();
      await database.asAdmin(
        `UPDATE app.workspace_inbox_entries SET created_at=statement_timestamp()-interval '721 hours',
      expires_at=statement_timestamp()-interval '1 hour' WHERE id=$1`,
        [fixture.ownerEntry],
      );
      await expect(
        asRuntime(
          fixture.workspaceId,
          fixture.owner.id,
          'pertexo_api',
          'SELECT id FROM app.workspace_inbox_entries',
        ),
      ).resolves.toEqual([]);
      await expect(
        database.asAdmin(
          'SELECT id FROM app.workspace_inbox_entries WHERE id=$1',
          [fixture.ownerEntry],
        ),
      ).resolves.toEqual([{ id: fixture.ownerEntry }]);
    });

    it('retains first read time on repeated updates and denies other-recipient writes', async () => {
      const fixture = await seed();
      const mark =
        'UPDATE app.workspace_inbox_entries SET read_at=clock_timestamp() WHERE id=$1 RETURNING read_at::text';
      const first = await asRuntime(
        fixture.workspaceId,
        fixture.owner.id,
        'pertexo_api',
        mark,
        [fixture.ownerEntry],
      );
      expect(first).toHaveLength(1);
      await expect(
        asRuntime(fixture.workspaceId, fixture.owner.id, 'pertexo_api', mark, [
          fixture.ownerEntry,
        ]),
      ).resolves.toEqual(first);
      await expect(
        asRuntime(
          fixture.workspaceId,
          fixture.owner.id,
          'pertexo_api',
          'UPDATE app.workspace_inbox_entries SET read_at=NULL WHERE id=$1 RETURNING read_at::text',
          [fixture.ownerEntry],
        ),
      ).resolves.toEqual(first);
      await expect(
        asRuntime(fixture.workspaceId, fixture.owner.id, 'pertexo_api', mark, [
          fixture.operatorEntry,
        ]),
      ).resolves.toEqual([]);
    });

    it('denies API source identity writes, deletes and audience inspection', async () => {
      const fixture = await seed();
      for (const sql of [
        'DELETE FROM app.workspace_inbox_entries',
        'SELECT * FROM app.workspace_inbox_audience',
        "UPDATE app.workspace_inbox_sources SET checksum=repeat('b',64)",
      ])
        await expect(
          asRuntime(fixture.workspaceId, fixture.owner.id, 'pertexo_api', sql),
        ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRuntime(
          fixture.workspaceId,
          fixture.owner.id,
          'pertexo_worker',
          "UPDATE app.workspace_inbox_sources SET expires_at=expires_at+interval '1 hour'",
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('rejects duplicate recipient delivery and cross-tenant references', async () => {
      const fixture = await seed();
      const insert = `INSERT INTO app.workspace_inbox_entries(id,workspace_id,source_id,user_id,creation_revision,created_at,expires_at)
      VALUES($1,$2,$3,$4,2,statement_timestamp(),statement_timestamp()+interval '720 hours')`;
      await expect(
        database.asAdmin(insert, [
          randomUUID(),
          fixture.workspaceId,
          fixture.sourceId,
          fixture.owner.id,
        ]),
      ).rejects.toMatchObject({ code: '23505' });
      const other = await database.workspace(fixture.owner.id);
      await expect(
        database.asAdmin(insert, [
          randomUUID(),
          other,
          fixture.sourceId,
          fixture.owner.id,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        database.asAdmin(
          'SELECT count(*)::int AS count FROM app.workspace_inbox_entries WHERE workspace_id=$1',
          [fixture.workspaceId],
        ),
      ).resolves.toEqual([{ count: 2 }]);
    });

    it('enforces fixed source horizons and preserves durable rows on rollback', async () => {
      const fixture = await seed();
      await expect(
        database.asAdmin(
          "UPDATE app.workspace_inbox_sources SET expires_at=expires_at+interval '1 second' WHERE id=$1",
          [fixture.sourceId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await database.asAdmin('BEGIN');
      await database.asAdmin(
        'DELETE FROM app.workspace_inbox_entries WHERE workspace_id=$1',
        [fixture.workspaceId],
      );
      await database.asAdmin('ROLLBACK');
      await expect(
        database.asAdmin(
          'SELECT count(*)::int AS count FROM app.workspace_inbox_entries WHERE workspace_id=$1',
          [fixture.workspaceId],
        ),
      ).resolves.toEqual([{ count: 2 }]);
      const purge = await database.asAdmin<{ definition: string }>(
        "SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure) AS definition",
      );
      const definition = purge[0]?.definition ?? '';
      const inbox = definition.indexOf("'workspace_inbox_entries'");
      expect(inbox).toBeGreaterThan(0);
      expect(definition.indexOf("'workspace_inbox_sources'")).toBeGreaterThan(
        inbox,
      );
      expect(definition.indexOf("'workflow_runs'")).toBeGreaterThan(
        definition.indexOf("'workspace_inbox_sources'"),
      );
    });

    it('purges inbox children in bounded guarded pages after a hold is released without affecting another workspace', async () => {
      const fixture = await seed();
      const unrelated = await seed();
      const maintenance = (statement: string, values: unknown[] = []) =>
        asRuntime(
          fixture.workspaceId,
          fixture.owner.id,
          'pertexo_maintenance',
          statement,
          values,
        );
      const counts = async (workspaceId: string) =>
        database.asAdmin(
          `SELECT
        (SELECT count(*)::int FROM app.workspace_inbox_entries WHERE workspace_id=$1) entries,
        (SELECT count(*)::int FROM app.workspace_inbox_audience WHERE workspace_id=$1) audience,
        (SELECT count(*)::int FROM app.workspace_inbox_recipient_state WHERE workspace_id=$1) recipients,
        (SELECT count(*)::int FROM app.workspace_inbox_sources WHERE workspace_id=$1) sources,
        (SELECT count(*)::int FROM app.workflow_runs WHERE workspace_id=$1) runs,
        (SELECT count(*)::int FROM app.workspace_memberships WHERE workspace_id=$1) memberships`,
          [workspaceId],
        );
      const intact = [
        {
          entries: 2,
          audience: 2,
          recipients: 2,
          sources: 1,
          runs: 1,
          memberships: 3,
        },
      ];
      await expect(counts(fixture.workspaceId)).resolves.toEqual(intact);
      await expect(counts(unrelated.workspaceId)).resolves.toEqual(intact);

      // Arrange ledger projections using the existing maintenance authority.
      // No external control-ledger/object-store provider verification is claimed.
      const requestedHash = '1'.repeat(64);
      const startedHash = '2'.repeat(64);
      const heldHash = '3'.repeat(64);
      const releasedHash = '4'.repeat(64);
      await maintenance(
        `SELECT app.project_workspace_deletion(
        $1,1,$2,'deletion_requested',$1,$3,$4,$5,NULL,
        'Inbox purge qualification',clock_timestamp()-interval '31 days')`,
        [
          fixture.workspaceId,
          randomUUID(),
          '0'.repeat(64),
          requestedHash,
          fixture.owner.id,
        ],
      );
      const [prepared] = await maintenance(
        `SELECT * FROM app.prepare_workspace_purge_job(
        $1,1,$2,'inbox-foundation-test',interval '1 minute')`,
        [fixture.workspaceId, requestedHash],
      );
      if (prepared === undefined) throw new Error('Expected owned purge job');
      await expect(
        maintenance(
          'SELECT app.project_workspace_purge_started($1,$2,$3,2,$4,$5) AS projected',
          [
            prepared.job_id,
            prepared.lease_token,
            prepared.lease_fence,
            requestedHash,
            startedHash,
          ],
        ),
      ).resolves.toEqual([{ projected: true }]);
      const [objects] = await maintenance(
        `SELECT * FROM app.claim_workspace_purge_step(
        $1,2,$2,'inbox-foundation-test',interval '1 minute')`,
        [prepared.job_id, startedHash],
      );
      if (objects === undefined) throw new Error('Expected owned object step');
      expect(objects.step_name).toBe('object_versions');
      // This fixture has no object rows. Complete only its empty object step.
      await maintenance(
        'SELECT app.checkpoint_workspace_object_versions_page($1,$2,$3,0,true,2,$4)',
        [
          prepared.job_id,
          objects.lease_token,
          objects.lease_fence,
          startedHash,
        ],
      );
      const [tenant] = await maintenance(
        `SELECT * FROM app.claim_workspace_purge_step(
        $1,2,$2,'inbox-foundation-test',interval '1 minute')`,
        [prepared.job_id, startedHash],
      );
      if (tenant === undefined) throw new Error('Expected owned tenant step');
      expect(tenant.step_name).toBe('tenant_rows');
      const holdId = randomUUID();
      await maintenance(
        `SELECT app.project_workspace_legal_hold(
        $1,3,$2,'legal_hold_placed',$3,$4,$5,'operator:inbox-test',
        'inbox-qualification','Preserve inbox evidence',clock_timestamp())`,
        [fixture.workspaceId, randomUUID(), holdId, startedHash, heldHash],
      );
      await expect(
        maintenance(
          `SELECT * FROM app.execute_workspace_tenant_rows_page(
        $1,$2,$3,1,3,$4)`,
          [prepared.job_id, tenant.lease_token, tenant.lease_fence, heldHash],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(counts(fixture.workspaceId)).resolves.toEqual(intact);
      await expect(counts(unrelated.workspaceId)).resolves.toEqual(intact);
      await maintenance(
        `SELECT app.project_workspace_legal_hold(
        $1,4,$2,'legal_hold_released',$3,$4,$5,'operator:inbox-test',
        'inbox-qualification','Release inbox evidence',clock_timestamp())`,
        [fixture.workspaceId, randomUUID(), holdId, heldHash, releasedHash],
      );

      let lease = tenant;
      let completed = false;
      const deletedInboxSurfaces: unknown[] = [];
      for (let page = 0; page < 80 && !completed; page += 1) {
        const [result] = await maintenance(
          `SELECT * FROM app.execute_workspace_tenant_rows_page(
          $1,$2,$3,1,4,$4)`,
          [prepared.job_id, lease.lease_token, lease.lease_fence, releasedHash],
        );
        if (result === undefined)
          throw new Error('Expected bounded purge page result');
        completed = result.completed === true;
        if (
          typeof result.surface === 'string' &&
          result.surface.startsWith('workspace_inbox_')
        ) {
          expect(result.affected_count).toBe(1);
          deletedInboxSurfaces.push(result.surface);
        }
        const [remaining] = await counts(fixture.workspaceId);
        if (remaining === undefined)
          throw new Error('Expected durable inbox counts');
        // Run and membership parents remain until every inbox child is gone.
        if (
          [
            remaining.entries,
            remaining.audience,
            remaining.recipients,
            remaining.sources,
          ].some((count) => count !== 0)
        ) {
          expect(remaining.runs).toBe(1);
          expect(remaining.memberships).toBe(3);
        }
        if (!completed) {
          const [next] = await maintenance(
            `SELECT * FROM app.claim_workspace_purge_step(
            $1,4,$2,'inbox-foundation-test',interval '1 minute')`,
            [prepared.job_id, releasedHash],
          );
          if (next === undefined)
            throw new Error('Expected next owned tenant step');
          expect(next.step_name).toBe('tenant_rows');
          lease = next;
        }
      }
      expect(completed).toBe(true);
      expect(deletedInboxSurfaces).toEqual([
        'workspace_inbox_entries',
        'workspace_inbox_entries',
        'workspace_inbox_audience',
        'workspace_inbox_audience',
        'workspace_inbox_recipient_state',
        'workspace_inbox_recipient_state',
        'workspace_inbox_sources',
      ]);
      await expect(counts(fixture.workspaceId)).resolves.toEqual([
        {
          entries: 0,
          audience: 0,
          recipients: 0,
          sources: 0,
          runs: 0,
          memberships: 0,
        },
      ]);
      await expect(counts(unrelated.workspaceId)).resolves.toEqual(intact);
      await expect(
        database.asAdmin(
          "SELECT status FROM app.workspace_purge_steps WHERE job_id=$1 AND step_name='tenant_rows'",
          [prepared.job_id],
        ),
      ).resolves.toEqual([{ status: 'completed' }]);
    });
  },
);
