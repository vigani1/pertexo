import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createWorkspaceInboxCaptureStore,
  createWorkspaceInboxProjectionStore,
  canonicalOutboxPayloadChecksum,
} from '../src/execution.js';
import {
  createIdentityWorkspaceDatabase,
  parseDatabaseConfig,
} from '../src/testing.js';
import { migrateDatabase } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import { runInboxWriteTransaction } from '../src/execution/workspace-inbox/inbox-write-transaction.js';

// Written during P1; execution requires separate authority for the established
// disposable environment. Never fall back to an unidentified local database.
const configured = [
  'DATABASE_ADMIN_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_API_URL',
  'DATABASE_WORKER_URL',
].every((name) => Boolean(process.env[name]));
describe.skipIf(!configured)(
  'inactive fan-out persistence, real PostgreSQL roles and transactions',
  () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL ?? '';
    const fixture = createDisposableDatabaseFixture({
      adminUrl,
      connectRoles: ['pertexo_migration', 'pertexo_api', 'pertexo_worker'],
      databaseName: `pertexo_test_inbox_projection_${randomUUID().replaceAll('-', '')}`,
      ownerRole: 'pertexo_owner',
    });
    const url = (name: string) => fixture.databaseUrl(process.env[name] ?? '');
    let admin: Pool;
    let worker: Pool;
    let api: Pool;
    let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;
    const closeResources: (() => Promise<void>)[] = [];
    const stores = new Set<{ close(): Promise<void> }>();
    beforeAll(async () => {
      await fixture.create();
      await migrateDatabase({
        connectionString: url('DATABASE_MIGRATION_URL'),
        ownerRole: 'pertexo_owner',
        apiRuntimeRole: 'pertexo_api',
        workerRuntimeRole: 'pertexo_worker',
        dispatcherRole: 'pertexo_dispatcher',
        maintenanceRole: 'pertexo_maintenance',
        operatorRole: 'pertexo_operator',
        lifecycleCommandRole: 'pertexo_lifecycle_command',
      });
      admin = new Pool({ connectionString: url('DATABASE_ADMIN_URL'), max: 4 });
      closeResources.push(() => admin.end());
      worker = new Pool({
        connectionString: url('DATABASE_WORKER_URL'),
        max: 4,
      });
      api = new Pool({ connectionString: url('DATABASE_API_URL'), max: 2 });
      closeResources.push(
        () => worker.end(),
        () => api.end(),
      );
      identity = createIdentityWorkspaceDatabase(
        parseDatabaseConfig({
          connectionString: url('DATABASE_API_URL'),
          max: 2,
        }),
      );
      closeResources.push(() => identity.close());
    }, 60_000);
    afterAll(async () => {
      const results = await Promise.allSettled(
        [...stores].map((store) => store.close()),
      );
      const pools = await Promise.allSettled(
        closeResources.map((close) => close()),
      );
      const errors = [...results, ...pools].flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          'Inbox projection fixture close failed; database retained',
        );
      await fixture.drop();
    });
    function store() {
      const created = createWorkspaceInboxCaptureStore(
        parseDatabaseConfig({
          connectionString: url('DATABASE_WORKER_URL'),
          max: 2,
        }),
      );
      stores.add(created);
      return created;
    }
    async function command(
      workspaceId: string,
      text: string,
      values: unknown[],
      commit = true,
    ) {
      const client = await worker.connect();
      try {
        await client.query('begin');
        await client.query(
          "select set_config('app.workspace_id',$1,true),set_config('lock_timeout','1000ms',true),set_config('statement_timeout','5000ms',true)",
          [workspaceId],
        );
        const result = await client.query<{ result: Record<string, unknown> }>(
          text,
          values,
        );
        await client.query(commit ? 'commit' : 'rollback');
        return result.rows[0]?.result;
      } catch (error: unknown) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }
    async function seed(extra = 0) {
      const owner = await identity.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Capture owner',
      });
      const workspace = await identity.createWorkspaceWithOwner({
        ownerUserId: owner.id,
        name: 'Capture fixture',
        slug: `capture-${randomUUID()}`,
      });
      for (let index = 0; index < extra; index++) {
        const user = await identity.createUser({
          email: `${randomUUID()}@example.test`,
          displayName: 'Operator',
        });
        await admin.query(
          "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'operator','active')",
          [workspace.id, user.id],
        );
      }
      const runId = randomUUID(),
        sourceId = randomUUID(),
        outboxEventId = randomUUID();
      const client = await api.connect();
      try {
        await client.query('begin');
        await client.query(
          "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
          [workspace.id, owner.id],
        );
        await client.query(
          "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','failed')",
          [runId, workspace.id, randomUUID(), randomUUID()],
        );
        await client.query('commit');
      } catch (error: unknown) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      await admin.query(
        `with occurred as (select statement_timestamp() t)
      insert into app.workspace_inbox_sources(id,workspace_id,run_id,terminal_event_sequence,kind,checksum,occurred_at,expires_at,evidence_until)
      select $1,$2,$3,1,'failed',app.workspace_inbox_source_checksum($2,$3,1,'failed',t),t,t+interval '720 hours',t+interval '2160 hours' from occurred`,
        [sourceId, workspace.id, runId],
      );
      const payload = {
        outboxEventId,
        schemaVersion: 1,
        sourceId,
        workspaceId: workspace.id,
      };
      const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
      // Arranged transport/source evidence, NOT an enabled terminal producer.
      await admin.query(
        "insert into app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum) values($1,$2,'project-workspace-inbox',1,'workspace-inbox-source',$3,$4::jsonb,$5)",
        [
          outboxEventId,
          workspace.id,
          sourceId,
          JSON.stringify(payload),
          payloadChecksum,
        ],
      );
      return {
        workspaceId: workspace.id,
        sourceId,
        workerId: 'capture-fixture',
        delivery: { outboxEventId, payloadChecksum },
        signal: new AbortController().signal,
        ownerId: owner.id,
      };
    }
    type Seed = Awaited<ReturnType<typeof seed>>;
    const intent = ({
      workspaceId,
      sourceId,
      workerId,
      delivery,
      signal,
    }: Seed) => ({ workspaceId, sourceId, workerId, delivery, signal });

    function projectionStore() {
      const created = createWorkspaceInboxProjectionStore(
        parseDatabaseConfig({
          connectionString: url('DATABASE_WORKER_URL'),
          max: 2,
        }),
      );
      stores.add(created);
      return created;
    }
    const projectionClaim = (item: Seed, lease = randomUUID()) =>
      command(
        item.workspaceId,
        'select app.claim_workspace_inbox_projection($1,$2,$3,$4,$5,$6) result',
        [
          item.workspaceId,
          item.sourceId,
          item.delivery.outboxEventId,
          item.delivery.payloadChecksum,
          item.workerId,
          lease,
        ],
      ).then((result) => ({ result, lease }));
    const project = (
      item: Seed,
      lease: string,
      fence: unknown,
      commit = true,
    ) =>
      command(
        item.workspaceId,
        'select app.project_workspace_inbox_page($1,$2,$3,$4) result',
        [item.workspaceId, item.sourceId, lease, fence],
        commit,
      );
    const fail = (item: Seed, lease: string, fence: unknown) =>
      command(
        item.workspaceId,
        'select app.fail_workspace_inbox_projection($1,$2,$3,$4) result',
        [item.workspaceId, item.sourceId, lease, fence],
      );
    async function users(item: Seed) {
      return (
        await admin.query<{ user_id: string }>(
          'select user_id from app.workspace_inbox_audience where workspace_id=$1 and source_id=$2 order by user_id',
          [item.workspaceId, item.sourceId],
        )
      ).rows.map((row) => row.user_id);
    }
    async function durable(item: Seed) {
      return (
        await admin.query<Record<string, unknown>>(
          `select status,last_recipient_user_id cursor,consecutive_attempts attempts,fence_token::text fence,lease_token,
        next_attempt_at>clock_timestamp() delayed,
        (select count(*)::int from app.workspace_inbox_entries where source_id=$1) entries,
        (select count(*)::int from app.workspace_inbox_audience where source_id=$1 and status='pending') pending,
        (select count(*)::int from app.workspace_inbox_audience where source_id=$1 and status='skipped') skipped,
        (select coalesce(sum(revision),0)::text from app.workspace_inbox_recipient_state where workspace_id=$2) revisions
        from app.workspace_inbox_sources where id=$1`,
          [item.sourceId, item.workspaceId],
        )
      ).rows[0];
    }
    async function addOperator(item: Seed) {
      const person = await identity.createUser({
        email: randomUUID() + '@example.test',
        displayName: 'Projection operator',
      });
      await admin.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'operator','active')",
        [item.workspaceId, person.id],
      );
      return person.id;
    }
    async function captureItem(item: Seed) {
      await expect(store().capture(intent(item))).resolves.toMatchObject({
        kind: 'captured',
      });
    }
    async function expire(item: Seed) {
      await admin.query(
        `update app.workspace_inbox_sources set occurred_at=occurred_at-interval '31 days',
        expires_at=expires_at-interval '31 days',evidence_until=evidence_until-interval '31 days',
        captured_at=case when captured_at is null then null else captured_at-interval '31 days' end
        where id=$1`,
        [item.sourceId],
      );
      await admin.query(
        'update app.workspace_inbox_sources set checksum=app.workspace_inbox_source_checksum(workspace_id,run_id,terminal_event_sequence,kind,occurred_at) where id=$1',
        [item.sourceId],
      );
    }
    async function waitForLock(pid: number) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const wait = await admin.query<{ waiting: boolean }>(
          "select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",
          [pid],
        );
        if (wait.rows[0]?.waiting === true) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('Expected bounded PostgreSQL lock wait was not observed');
    }
    it('uses narrow real-role authority and denies every raw progress/decision/revision grant', async () => {
      const item = await seed();
      await projectionStore().checkReadiness();
      for (const { sql, values } of [
        {
          sql: 'insert into app.workspace_inbox_audience(workspace_id,source_id,user_id,observed_role_revision) values($1,$2,$3,1)',
          values: [item.workspaceId, item.sourceId, item.ownerId],
        },
        {
          sql: 'insert into app.workspace_inbox_recipient_state(workspace_id,user_id) values($1,$2)',
          values: [item.workspaceId, item.ownerId],
        },
        {
          sql: "insert into app.workspace_inbox_entries(id,workspace_id,source_id,user_id,creation_revision,expires_at) values(gen_random_uuid(),$1,$2,$3,1,clock_timestamp()+interval '720 hours')",
          values: [item.workspaceId, item.sourceId, item.ownerId],
        },
        {
          sql: "update app.workspace_inbox_audience set status='skipped',processed_at=clock_timestamp() where workspace_id=$1 and source_id=$2 and user_id=$3",
          values: [item.workspaceId, item.sourceId, item.ownerId],
        },
        {
          sql: 'update app.workspace_inbox_recipient_state set revision=revision+1 where workspace_id=$1 and user_id=$2',
          values: [item.workspaceId, item.ownerId],
        },
      ])
        await expect(
          command(item.workspaceId, sql, values),
        ).rejects.toMatchObject({ code: '42501' });
      for (const column of [
        'status',
        'captured_at',
        'audience_count',
        'last_recipient_user_id',
        'consecutive_attempts',
        'next_attempt_at',
        'fence_token',
        'lease_owner',
        'lease_token',
        'lease_expires_at',
        'updated_at',
      ])
        await expect(
          command(
            item.workspaceId,
            `update app.workspace_inbox_sources set ${column}=${column} where id=$1`,
            [item.sourceId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      await expect(
        command(
          item.workspaceId,
          'select app.validate_workspace_inbox_delivery($1,$2,$3,$4) result',
          [
            item.workspaceId,
            item.sourceId,
            item.delivery.outboxEventId,
            item.delivery.payloadChecksum,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await captureItem(item);
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toEqual({
        kind: 'projected',
        processedCount: 1,
        insertedCount: 1,
        skippedCount: 0,
        hasMore: false,
      });
    });
    it('pages more than 100 frozen recipients without adding a late member', async () => {
      const item = await seed();
      // Bulk arrangement only: no enabled producer or invented application user API.
      await admin.query(
        `with people as (
        insert into app.users(id,email,display_name,status) select gen_random_uuid(),gen_random_uuid()::text||'@example.test','Bulk operator','active' from generate_series(1,104) returning id
      ) insert into app.workspace_memberships(workspace_id,user_id,role,status) select $1,id,'operator','active' from people`,
        [item.workspaceId],
      );
      await captureItem(item);
      const captured = await users(item),
        late = await addOperator(item);
      const projection = projectionStore();
      await expect(projection.projectNextPage(intent(item))).resolves.toEqual({
        kind: 'projected',
        processedCount: 100,
        insertedCount: 100,
        skippedCount: 0,
        hasMore: true,
      });
      expect(await durable(item)).toMatchObject({
        status: 'captured',
        cursor: captured[99],
        entries: 100,
        pending: 5,
        revisions: '100',
        attempts: 0,
        lease_token: null,
      });
      await expect(projection.projectNextPage(intent(item))).resolves.toEqual({
        kind: 'projected',
        processedCount: 5,
        insertedCount: 5,
        skippedCount: 0,
        hasMore: false,
      });
      expect(await durable(item)).toMatchObject({
        status: 'completed',
        cursor: captured[104],
        entries: 105,
        pending: 0,
        revisions: '105',
        attempts: 0,
        lease_token: null,
      });
      expect(
        (
          await admin.query(
            'select 1 from app.workspace_inbox_audience where source_id=$1 and user_id=$2',
            [item.sourceId, late],
          )
        ).rowCount,
      ).toBe(0);
      await expect(projection.projectNextPage(intent(item))).resolves.toEqual({
        kind: 'completed',
      });
      expect((await durable(item))?.revisions).toBe('105');
    }, 15_000);
    it('allows eligible role-revision changes, permanently skips processed ineligible recipients, and excludes late joins', async () => {
      const item = await seed(),
        operator = await addOperator(item);
      await captureItem(item);
      await identity.changeWorkspaceMemberRole({
        workspaceId: item.workspaceId,
        actorUserId: item.ownerId,
        targetUserId: operator,
        role: 'admin',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toMatchObject({ insertedCount: 2, skippedCount: 0 });
      expect(
        (
          await admin.query<{ observed_role_revision: number }>(
            'select observed_role_revision from app.workspace_inbox_audience where source_id=$1 and user_id=$2',
            [item.sourceId, operator],
          )
        ).rows[0]?.observed_role_revision,
      ).toBe(1);
      const second = await seed(),
        removed = await addOperator(second);
      await captureItem(second);
      await identity.removeWorkspaceMember({
        workspaceId: second.workspaceId,
        actorUserId: second.ownerId,
        targetUserId: removed,
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await expect(
        projectionStore().projectNextPage(intent(second)),
      ).resolves.toMatchObject({ insertedCount: 1, skippedCount: 1 });
      await admin.query(
        "update app.workspace_memberships set status='active',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
        [second.workspaceId, removed],
      );
      await expect(
        projectionStore().projectNextPage(intent(second)),
      ).resolves.toEqual({ kind: 'completed' });
      expect(await durable(second)).toMatchObject({
        entries: 1,
        skipped: 1,
        revisions: '1',
      });
    });
    it('restoration before the decision remains eligible and zero audience completes', async () => {
      const item = await seed(),
        operator = await addOperator(item);
      await captureItem(item);
      await identity.suspendWorkspaceMember({
        workspaceId: item.workspaceId,
        actorUserId: item.ownerId,
        targetUserId: operator,
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await identity.reactivateWorkspaceMember({
        workspaceId: item.workspaceId,
        actorUserId: item.ownerId,
        targetUserId: operator,
        expectedRoleRevision: 2,
        idempotencyKey: randomUUID(),
      });
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toMatchObject({ insertedCount: 2 });
      const empty = await seed();
      await admin.query("update app.users set status='suspended' where id=$1", [
        empty.ownerId,
      ]);
      await captureItem(empty);
      await expect(
        projectionStore().projectNextPage(intent(empty)),
      ).resolves.toEqual({
        kind: 'projected',
        processedCount: 0,
        insertedCount: 0,
        skippedCount: 0,
        hasMore: false,
      });
      expect(await durable(empty)).toMatchObject({
        status: 'completed',
        entries: 0,
        revisions: '0',
      });
    });
    it('reconciles concurrent claims and stale fences without duplicate visible entries or revisions', async () => {
      const item = await seed();
      await captureItem(item);
      const results = await Promise.all([
        projectionClaim(item),
        projectionClaim(item),
      ]);
      expect(results.map((result) => result.result?.kind).sort()).toEqual([
        'busy',
        'owned',
      ]);
      const owner = results.find((result) => result.result?.kind === 'owned'),
        loser = results.find((result) => result.result?.kind === 'busy');
      if (owner === undefined || loser === undefined)
        throw new Error('Expected one owner');
      await expect(
        project(item, loser.lease, owner.result?.fenceToken),
      ).resolves.toEqual({ kind: 'lost_ownership' });
      await expect(
        project(item, owner.lease, owner.result?.fenceToken),
      ).resolves.toMatchObject({ insertedCount: 1, hasMore: false });
      await expect(
        project(item, owner.lease, owner.result?.fenceToken),
      ).resolves.toEqual({ kind: 'lost_ownership' });
      await expect(projectionClaim(item)).resolves.toMatchObject({
        result: { kind: 'completed' },
      });
      expect(await durable(item)).toMatchObject({
        entries: 1,
        revisions: '1',
        pending: 0,
        status: 'completed',
      });
    });
    it('rolls the entire page back, then accounts once and blocks the tenth acquisition', async () => {
      const item = await seed();
      await captureItem(item);
      await admin.query(
        'update app.workspace_inbox_sources set consecutive_attempts=9 where id=$1',
        [item.sourceId],
      );
      const owner = await projectionClaim(item);
      await expect(
        project(item, owner.lease, owner.result?.fenceToken, false),
      ).resolves.toMatchObject({ insertedCount: 1 });
      expect(await durable(item)).toMatchObject({
        entries: 0,
        revisions: '0',
        pending: 1,
        attempts: 10,
        cursor: null,
      });
      await expect(
        fail(item, owner.lease, owner.result?.fenceToken),
      ).resolves.toEqual({ kind: 'blocked' });
      await expect(projectionClaim(item)).resolves.toMatchObject({
        result: { kind: 'blocked' },
      });
      const before = await durable(item);
      await expect(store().capture(intent(item))).resolves.toEqual({
        kind: 'captured',
        audienceCount: '1',
      });
      expect(await durable(item)).toEqual(before);
    });
    it('preserves a live projection lease and completed progress during capture retries', async () => {
      const item = await seed();
      await captureItem(item);
      const owner = await projectionClaim(item),
        before = await durable(item);
      await expect(store().capture(intent(item))).resolves.toEqual({
        kind: 'captured',
        audienceCount: '1',
      });
      await expect(
        command(
          item.workspaceId,
          'select app.fail_workspace_inbox_capture($1,$2,$3,$4) result',
          [
            item.workspaceId,
            item.sourceId,
            owner.lease,
            owner.result?.fenceToken,
          ],
        ),
      ).resolves.toEqual({ kind: 'captured', audienceCount: '1' });
      expect(await durable(item)).toEqual(before);
      await project(item, owner.lease, owner.result?.fenceToken);
      const complete = await durable(item);
      await expect(store().capture(intent(item))).resolves.toEqual({
        kind: 'captured',
        audienceCount: '1',
      });
      expect(await durable(item)).toEqual(complete);
    });
    it('reconciles an expired projection acquisition with durable delay before takeover', async () => {
      const item = await seed();
      await captureItem(item);
      const original = await projectionClaim(item);
      await admin.query(
        "update app.workspace_inbox_sources set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [item.sourceId],
      );
      await expect(projectionClaim(item)).resolves.toMatchObject({
        result: { kind: 'retry_scheduled' },
      });
      expect(await durable(item)).toMatchObject({
        attempts: 1,
        entries: 0,
        delayed: true,
        lease_token: null,
      });
      await expect(projectionClaim(item)).resolves.toMatchObject({
        result: { kind: 'not_due' },
      });
      await admin.query(
        "update app.workspace_inbox_sources set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",
        [item.sourceId],
      );
      const next = await projectionClaim(item);
      await expect(
        project(item, original.lease, original.result?.fenceToken),
      ).resolves.toEqual({ kind: 'lost_ownership' });
      await expect(
        project(item, next.lease, next.result?.fenceToken),
      ).resolves.toMatchObject({ insertedCount: 1 });
      expect(await durable(item)).toMatchObject({
        attempts: 0,
        entries: 1,
        revisions: '1',
      });
    });
    it('waits for actual user locks and rechecks a racing suspended user before insertion', async () => {
      const item = await seed(),
        operator = await addOperator(item);
      await captureItem(item);
      const owner = await projectionClaim(item),
        blocker = await admin.connect(),
        writer = await worker.connect();
      try {
        await blocker.query('begin');
        await blocker.query(
          "update app.users set status='suspended' where id=$1",
          [operator],
        );
        await writer.query('begin');
        await writer.query(
          "select set_config('app.workspace_id',$1,true),set_config('lock_timeout','1000ms',true)",
          [item.workspaceId],
        );
        const pid = (
          await writer.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        if (pid === undefined) throw new Error('Writer PID missing');
        const page = writer.query<{ result: unknown }>(
          'select app.project_workspace_inbox_page($1,$2,$3,$4) result',
          [
            item.workspaceId,
            item.sourceId,
            owner.lease,
            owner.result?.fenceToken,
          ],
        );
        await waitForLock(pid);
        await blocker.query('commit');
        expect((await page).rows[0]?.result).toMatchObject({
          insertedCount: 1,
          skippedCount: 1,
        });
        await writer.query('commit');
        expect(await durable(item)).toMatchObject({
          entries: 1,
          skipped: 1,
          revisions: '1',
        });
      } finally {
        await blocker.query('rollback');
        await writer.query('rollback');
        blocker.release();
        writer.release();
      }
    });
    it('returns stale ownership after a cursor/fence changes while waiting for the source lock, without new participant locks', async () => {
      const item = await seed();
      await captureItem(item);
      const owner = await projectionClaim(item),
        blocker = await admin.connect(),
        writer = await worker.connect();
      try {
        await blocker.query('begin');
        await blocker.query(
          'select id from app.workspace_inbox_sources where id=$1 for update',
          [item.sourceId],
        );
        await writer.query('begin');
        await writer.query(
          "select set_config('app.workspace_id',$1,true),set_config('lock_timeout','1000ms',true)",
          [item.workspaceId],
        );
        const pid = (
          await writer.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        if (pid === undefined) throw new Error('Writer PID missing');
        const page = writer.query<{ result: unknown }>(
          'select app.project_workspace_inbox_page($1,$2,$3,$4) result',
          [
            item.workspaceId,
            item.sourceId,
            owner.lease,
            owner.result?.fenceToken,
          ],
        );
        await waitForLock(pid);
        await blocker.query(
          'update app.workspace_inbox_sources set fence_token=fence_token+1 where id=$1',
          [item.sourceId],
        );
        await blocker.query('commit');
        expect((await page).rows[0]?.result).toEqual({
          kind: 'lost_ownership',
        });
        await writer.query('commit');
        expect(await durable(item)).toMatchObject({
          entries: 0,
          pending: 1,
          cursor: null,
          revisions: '0',
        });
      } finally {
        await blocker.query('rollback');
        await writer.query('rollback');
        blocker.release();
        writer.release();
      }
    });
    it('rolls back a same-owner changed candidate set rather than locking an added user', async () => {
      const item = await seed(),
        extra = await addOperator(item);
      await captureItem(item);
      const owner = await projectionClaim(item),
        blocker = await admin.connect(),
        writer = await worker.connect();
      try {
        await blocker.query('begin');
        await blocker.query(
          'select id from app.workspace_inbox_sources where id=$1 for update',
          [item.sourceId],
        );
        await writer.query('begin');
        await writer.query(
          "select set_config('app.workspace_id',$1,true),set_config('lock_timeout','1000ms',true)",
          [item.workspaceId],
        );
        const pid = (
          await writer.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        if (pid === undefined) throw new Error('Writer PID missing');
        const page = writer
          .query(
            'select app.project_workspace_inbox_page($1,$2,$3,$4) result',
            [
              item.workspaceId,
              item.sourceId,
              owner.lease,
              owner.result?.fenceToken,
            ],
          )
          .then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
        await waitForLock(pid);
        await blocker.query(
          "update app.workspace_inbox_audience set status='skipped',processed_at=clock_timestamp() where source_id=$1 and user_id=$2",
          [item.sourceId, extra],
        );
        await blocker.query('commit');
        expect(await page).toMatchObject({
          error: {
            code: '22023',
            message: 'inbox projection checkpoint mismatch',
          },
        });
        await writer.query('rollback');
        expect(await durable(item)).toMatchObject({
          entries: 0,
          revisions: '0',
          cursor: null,
        });
      } finally {
        await blocker.query('rollback');
        await writer.query('rollback');
        blocker.release();
        writer.release();
      }
    });
    it('does not duplicate or restamp a real page COMMIT with a delayed acknowledgment', async () => {
      const item = await seed();
      await captureItem(item);
      const owner = await projectionClaim(item);
      const reached = Promise.withResolvers<undefined>(),
        releaseAck = Promise.withResolvers<undefined>(),
        controller = new AbortController();
      const actual = await worker.connect();
      const wrapped = new Proxy(actual, {
        get(target, property) {
          if (property === 'query')
            return async (text: string, values: unknown[]) => {
              const result = await target.query(text, values);
              if (text === 'commit') {
                reached.resolve(undefined);
                await releaseAck.promise;
              }
              return result;
            };
          const value: unknown = Reflect.get(target, property);
          const bound: unknown =
            typeof value === 'function' ? value.bind(target) : value;
          return bound;
        },
      });
      const transaction = runInboxWriteTransaction(
        { connect: () => Promise.resolve(wrapped) } as unknown as Pool,
        item.workspaceId,
        controller.signal,
        {
          track: <T>(promise: Promise<T>) => promise,
          failDisposal: () => {
            throw new Error('Unexpected disposal failure');
          },
        },
        'select app.project_workspace_inbox_page($1,$2,$3,$4) result',
        [
          item.workspaceId,
          item.sourceId,
          owner.lease,
          owner.result?.fenceToken,
        ],
        (row) => row,
        'projection',
      );
      await Promise.race([
        reached.promise,
        transaction.then(() => {
          throw new Error('Page ended before barrier');
        }),
      ]);
      controller.abort();
      releaseAck.resolve(undefined);
      expect((await transaction).kind).toBe('uncertain');
      const rows = await admin.query(
        'select id,creation_revision::text,created_at::text from app.workspace_inbox_entries where source_id=$1',
        [item.sourceId],
      );
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toEqual({ kind: 'completed' });
      expect(
        (
          await admin.query(
            'select id,creation_revision::text,created_at::text from app.workspace_inbox_entries where source_id=$1',
            [item.sourceId],
          )
        ).rows,
      ).toEqual(rows.rows);
      expect(await durable(item)).toMatchObject({
        entries: 1,
        revisions: '1',
        attempts: 0,
        status: 'completed',
      });
    });
    it('expires an unprocessed source, while a previously created entry keeps its own lifetime', async () => {
      const item = await seed();
      await captureItem(item);
      await projectionStore().projectNextPage(intent(item));
      await expire(item);
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toEqual({ kind: 'expired' });
      expect(
        (
          await admin.query(
            'select expires_at>clock_timestamp() visible from app.workspace_inbox_entries where source_id=$1',
            [item.sourceId],
          )
        ).rows,
      ).toEqual([{ visible: true }]);
      expect(await durable(item)).toMatchObject({ entries: 1, revisions: '1' });
      const pending = await seed();
      await captureItem(pending);
      await expire(pending);
      await expect(
        projectionStore().projectNextPage(intent(pending)),
      ).resolves.toEqual({ kind: 'expired' });
      expect(await durable(pending)).toMatchObject({ entries: 0, pending: 1 });
    });
    it('enforces real two-second statement timeout and rolls back all page state', async () => {
      const item = await seed();
      await captureItem(item);
      await admin.query(
        'CREATE FUNCTION app.test_inbox_projection_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$',
      );
      await admin.query(
        `CREATE TRIGGER test_inbox_projection_delay BEFORE INSERT ON app.workspace_inbox_entries FOR EACH ROW WHEN(NEW.source_id='${item.sourceId}'::uuid) EXECUTE FUNCTION app.test_inbox_projection_delay()`,
      );
      try {
        await expect(
          projectionStore().projectNextPage(intent(item)),
        ).resolves.toEqual({ kind: 'retry_scheduled' });
        expect(await durable(item)).toMatchObject({
          entries: 0,
          revisions: '0',
          pending: 1,
          cursor: null,
          attempts: 1,
          delayed: true,
          lease_token: null,
        });
      } finally {
        await admin.query(
          'DROP TRIGGER test_inbox_projection_delay ON app.workspace_inbox_entries',
        );
        await admin.query('DROP FUNCTION app.test_inbox_projection_delay()');
      }
    }, 10_000);
    it('keeps tenant/context/checksum and removed-evidence dispositions fail-closed', async () => {
      const item = await seed();
      await captureItem(item);
      const other = await seed();
      await expect(
        command(
          other.workspaceId,
          'select app.claim_workspace_inbox_projection($1,$2,$3,$4,$5,$6) result',
          [
            item.workspaceId,
            item.sourceId,
            item.delivery.outboxEventId,
            item.delivery.payloadChecksum,
            item.workerId,
            randomUUID(),
          ],
        ),
      ).rejects.toMatchObject({ code: '22023' });
      await expect(
        projectionStore().projectNextPage({
          ...intent(item),
          delivery: { ...item.delivery, payloadChecksum: 'b'.repeat(64) },
        }),
      ).rejects.toThrow('claim rejected');
      await admin.query('delete from app.outbox_events where id=$1', [
        item.delivery.outboxEventId,
      ]);
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).rejects.toThrow('claim rejected');
      await admin.query(
        'delete from app.workspace_inbox_audience where source_id=$1',
        [item.sourceId],
      );
      await admin.query('delete from app.workspace_inbox_sources where id=$1', [
        item.sourceId,
      ]);
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toEqual({ kind: 'unavailable' });
    });
    it('rolls back a page that finishes after fixed source expiry, without extending its horizon', async () => {
      const item = await seed();
      await captureItem(item);
      await admin.query(
        `with boundary as(select clock_timestamp()+interval '1 second' t)
        update app.workspace_inbox_sources set occurred_at=t-interval '720 hours',expires_at=t,evidence_until=t+interval '1440 hours',
          checksum=app.workspace_inbox_source_checksum(workspace_id,run_id,terminal_event_sequence,kind,t-interval '720 hours')
        from boundary where id=$1`,
        [item.sourceId],
      );
      await admin.query(
        'CREATE FUNCTION app.test_inbox_projection_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.2); RETURN NEW; END $$',
      );
      await admin.query(
        `CREATE TRIGGER test_inbox_projection_expiry BEFORE INSERT ON app.workspace_inbox_entries FOR EACH ROW WHEN(NEW.source_id='${item.sourceId}'::uuid) EXECUTE FUNCTION app.test_inbox_projection_expiry()`,
      );
      try {
        await expect(
          projectionStore().projectNextPage(intent(item)),
        ).resolves.toEqual({ kind: 'expired' });
        expect(await durable(item)).toMatchObject({
          status: 'expired',
          entries: 0,
          revisions: '0',
          pending: 1,
          cursor: null,
          lease_token: null,
        });
      } finally {
        await admin.query(
          'DROP TRIGGER test_inbox_projection_expiry ON app.workspace_inbox_entries',
        );
        await admin.query('DROP FUNCTION app.test_inbox_projection_expiry()');
      }
    });
    it('resets a successful tenth projection acquisition and never restamps read entries or recreates deleted entries', async () => {
      const item = await seed();
      await captureItem(item);
      await admin.query(
        'update app.workspace_inbox_sources set consecutive_attempts=9 where id=$1',
        [item.sourceId],
      );
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toMatchObject({ insertedCount: 1, hasMore: false });
      expect(await durable(item)).toMatchObject({
        attempts: 0,
        entries: 1,
        revisions: '1',
      });
      await admin.query(
        'update app.workspace_inbox_entries set read_at=clock_timestamp() where source_id=$1',
        [item.sourceId],
      );
      const original = (
        await admin.query(
          'select id,creation_revision::text,read_at::text from app.workspace_inbox_entries where source_id=$1',
          [item.sourceId],
        )
      ).rows;
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toEqual({ kind: 'completed' });
      expect(
        (
          await admin.query(
            'select id,creation_revision::text,read_at::text from app.workspace_inbox_entries where source_id=$1',
            [item.sourceId],
          )
        ).rows,
      ).toEqual(original);
      await admin.query(
        'delete from app.workspace_inbox_entries where source_id=$1',
        [item.sourceId],
      );
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toEqual({ kind: 'completed' });
      expect(await durable(item)).toMatchObject({
        entries: 0,
        revisions: '1',
        pending: 0,
      });
    });
    it('serializes different source pages for the same recipient without deadlock or revision collision', async () => {
      const item = await seed();
      await captureItem(item);
      const sourceId = randomUUID(),
        outboxEventId = randomUUID(),
        payload = {
          outboxEventId,
          schemaVersion: 1,
          sourceId,
          workspaceId: item.workspaceId,
        };
      const next = {
        ...item,
        sourceId,
        delivery: {
          outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(payload),
        },
      };
      await admin.query(
        `insert into app.workspace_inbox_sources(id,workspace_id,run_id,terminal_event_sequence,kind,checksum,occurred_at,expires_at,evidence_until)
        select $2,workspace_id,run_id,terminal_event_sequence+1,kind,
          app.workspace_inbox_source_checksum(workspace_id,run_id,terminal_event_sequence+1,kind,occurred_at),occurred_at,expires_at,evidence_until
        from app.workspace_inbox_sources where id=$1`,
        [item.sourceId, sourceId],
      );
      await admin.query(
        "insert into app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum) values($1,$2,'project-workspace-inbox',1,'workspace-inbox-source',$3,$4::jsonb,$5)",
        [
          outboxEventId,
          item.workspaceId,
          sourceId,
          JSON.stringify(payload),
          next.delivery.payloadChecksum,
        ],
      );
      await captureItem(next);
      const owners = await Promise.all([
        projectionClaim(item),
        projectionClaim(next),
      ]);
      expect(owners.map((owner) => owner.result?.kind)).toEqual([
        'owned',
        'owned',
      ]);
      const first = owners[0],
        second = owners[1];
      const results = await Promise.all([
        project(item, first.lease, first.result?.fenceToken),
        project(next, second.lease, second.result?.fenceToken),
      ]);
      expect(results).toEqual([
        {
          kind: 'projected',
          processedCount: 1,
          insertedCount: 1,
          skippedCount: 0,
          hasMore: false,
        },
        {
          kind: 'projected',
          processedCount: 1,
          insertedCount: 1,
          skippedCount: 0,
          hasMore: false,
        },
      ]);
      expect(
        (
          await admin.query(
            'select creation_revision::text from app.workspace_inbox_entries where workspace_id=$1 order by creation_revision',
            [item.workspaceId],
          )
        ).rows,
      ).toEqual([{ creation_revision: '1' }, { creation_revision: '2' }]);
      expect(await durable(item)).toMatchObject({
        status: 'completed',
        entries: 1,
        revisions: '2',
      });
      expect(await durable(next)).toMatchObject({
        status: 'completed',
        entries: 1,
        revisions: '2',
      });
    });
    it('distinguishes inactive and uncaptured sources without manufacturing an empty completion', async () => {
      const item = await seed();
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toEqual({ kind: 'not_captured' });
      await admin.query(
        "update app.workspaces set status='suspended' where id=$1",
        [item.workspaceId],
      );
      await expect(
        projectionStore().projectNextPage(intent(item)),
      ).resolves.toEqual({ kind: 'inactive' });
      expect(await durable(item)).toMatchObject({
        status: 'pending',
        entries: 0,
        attempts: 0,
      });
    });
  },
);
