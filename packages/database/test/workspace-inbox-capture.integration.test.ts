import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createWorkspaceInboxCaptureStore,
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
  'inactive inbox capture, real PostgreSQL roles and transactions',
  () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL ?? '';
    const fixture = createDisposableDatabaseFixture({
      adminUrl,
      connectRoles: ['pertexo_migration', 'pertexo_api', 'pertexo_worker'],
      databaseName: `pertexo_test_inbox_capture_${randomUUID().replaceAll('-', '')}`,
      ownerRole: 'pertexo_owner',
    });
    const url = (name: string) => fixture.databaseUrl(process.env[name] ?? '');
    let admin: Pool;
    let worker: Pool;
    let api: Pool;
    let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;
    const closeResources: (() => Promise<void>)[] = [];
    const stores = new Set<
      ReturnType<typeof createWorkspaceInboxCaptureStore>
    >();
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
          'Inbox capture fixture close failed; database retained',
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
    const claim = (item: Seed, lease = randomUUID()) =>
      command(
        item.workspaceId,
        'select app.claim_workspace_inbox_capture($1,$2,$3,$4,$5,$6) result',
        [
          item.workspaceId,
          item.sourceId,
          item.delivery.outboxEventId,
          item.delivery.payloadChecksum,
          item.workerId,
          lease,
        ],
      ).then((result) => ({ result, lease }));
    const capture = (
      item: Seed,
      lease: string,
      fence: unknown,
      commit = true,
    ) =>
      command(
        item.workspaceId,
        'select app.capture_workspace_inbox_audience($1,$2,$3,$4) result',
        [item.workspaceId, item.sourceId, lease, fence],
        commit,
      );
    const state = async (item: Seed) =>
      (
        await admin.query(
          'select status,captured_at is not null captured,audience_count::text count,consecutive_attempts attempts,fence_token::text fence,lease_token,next_attempt_at>clock_timestamp() deferred from app.workspace_inbox_sources where id=$1',
          [item.sourceId],
        )
      ).rows[0] as Record<string, unknown>;

    it('checks narrow runtime command authority and rejects absent/cross-tenant context', async () => {
      const item = await seed();
      await store().checkReadiness();
      await expect(
        worker.query(
          'select app.claim_workspace_inbox_capture($1,$2,$3,$4,$5,$6)',
          [
            item.workspaceId,
            item.sourceId,
            item.delivery.outboxEventId,
            item.delivery.payloadChecksum,
            'worker',
            randomUUID(),
          ],
        ),
      ).rejects.toThrow('scope');
      const other = await seed();
      await expect(
        command(
          other.workspaceId,
          'select app.claim_workspace_inbox_capture($1,$2,$3,$4,$5,$6) result',
          [
            item.workspaceId,
            item.sourceId,
            item.delivery.outboxEventId,
            item.delivery.payloadChecksum,
            'worker',
            randomUUID(),
          ],
        ),
      ).rejects.toThrow('scope');
      await expect(
        api.query('select app.capture_workspace_inbox_audience($1,$2,$3,$4)', [
          item.workspaceId,
          item.sourceId,
          randomUUID(),
          1,
        ]),
      ).rejects.toThrow('permission denied');
      await expect(worker.query('select email from app.users')).rejects.toThrow(
        'permission denied',
      );
      expect(await state(item)).toMatchObject({ attempts: 0, captured: false });
    });
    it('captures more than a fanout page and reconciles the immutable audience after a lost acknowledgment', async () => {
      const item = await seed(103);
      const service = store();
      await expect(service.capture(intent(item))).resolves.toEqual({
        kind: 'captured',
        audienceCount: '104',
      });
      const rows = await admin.query(
        'select user_id,observed_role_revision from app.workspace_inbox_audience where source_id=$1 order by user_id',
        [item.sourceId],
      );
      expect(rows.rows).toHaveLength(104);
      const late = await identity.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Late operator',
      });
      await admin.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'operator','active')",
        [item.workspaceId, late.id],
      );
      // Treat the acknowledged durable result as lost to the caller; exact retry
      // must read it, not capture the subsequently changed membership snapshot.
      await expect(service.capture(intent(item))).resolves.toEqual({
        kind: 'captured',
        audienceCount: '104',
      });
      expect(
        (
          await admin.query(
            'select user_id,observed_role_revision from app.workspace_inbox_audience where source_id=$1 order by user_id',
            [item.sourceId],
          )
        ).rows,
      ).toEqual(rows.rows);
      expect(await state(item)).toMatchObject({
        captured: true,
        attempts: 0,
        lease_token: null,
      });
    });
    it('gives independent database contenders one claim and fences the loser', async () => {
      const item = await seed();
      const leases = [randomUUID(), randomUUID()];
      const attempts = await Promise.all([
        claim(item, leases[0]),
        claim(item, leases[1]),
      ]);
      expect(attempts.map((attempt) => attempt.result?.kind).sort()).toEqual([
        'busy',
        'owned',
      ]);
      const winner = attempts.find(
        (attempt) => attempt.result?.kind === 'owned',
      );
      if (winner === undefined) throw new Error('Missing winner');
      const loser = attempts.find((attempt) => attempt !== winner);
      if (loser === undefined) throw new Error('Missing loser');
      await expect(
        capture(item, loser.lease, winner.result?.fenceToken),
      ).resolves.toEqual({ kind: 'lost_ownership' });
      await expect(
        capture(item, winner.lease, winner.result?.fenceToken),
      ).resolves.toEqual({ kind: 'captured', audienceCount: '1' });
      expect(await state(item)).toMatchObject({
        count: '1',
        fence: '1',
        attempts: 0,
      });
    });
    it('distinguishes an inactive workspace from a legitimate empty audience', async () => {
      const inactive = await seed();
      await admin.query(
        "update app.workspaces set status='suspended' where id=$1",
        [inactive.workspaceId],
      );
      await expect(store().capture(intent(inactive))).resolves.toEqual({
        kind: 'inactive',
      });
      expect(await state(inactive)).toMatchObject({
        captured: false,
        attempts: 0,
      });
      const empty = await seed();
      await admin.query("update app.users set status='suspended' where id=$1", [
        empty.ownerId,
      ]);
      await expect(store().capture(intent(empty))).resolves.toEqual({
        kind: 'captured',
        audienceCount: '0',
      });
      expect(await state(empty)).toMatchObject({ captured: true, count: '0' });
    });
    it('rolls audience and marker back together and records a fenced retry separately', async () => {
      const item = await seed();
      const owned = await claim(item);
      await expect(
        capture(item, owned.lease, owned.result?.fenceToken, false),
      ).resolves.toEqual({ kind: 'captured', audienceCount: '1' });
      expect(await state(item)).toMatchObject({
        captured: false,
        count: '0',
        attempts: 1,
      });
      expect(
        (
          await admin.query(
            'select * from app.workspace_inbox_audience where source_id=$1',
            [item.sourceId],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        command(
          item.workspaceId,
          'select app.fail_workspace_inbox_capture($1,$2,$3,$4) result',
          [
            item.workspaceId,
            item.sourceId,
            owned.lease,
            owned.result?.fenceToken,
          ],
        ),
      ).resolves.toEqual({ kind: 'retry_scheduled' });
      expect(await state(item)).toMatchObject({
        captured: false,
        attempts: 1,
        lease_token: null,
        deferred: true,
      });
      await expect(
        capture(item, owned.lease, owned.result?.fenceToken),
      ).resolves.toEqual({ kind: 'lost_ownership' });
    });
    it.each(['known rollback', 'lost accounting'] as const)(
      'blocks the tenth acquisition after %s without an eleventh or recapture',
      async (mode) => {
        const item = await seed();
        await admin.query(
          'update app.workspace_inbox_sources set consecutive_attempts=9 where id=$1',
          [item.sourceId],
        );
        const owned = await claim(item);
        expect(owned.result?.kind).toBe('owned');
        expect(await state(item)).toMatchObject({ attempts: 10 });
        if (mode === 'known rollback')
          await expect(
            command(
              item.workspaceId,
              'select app.fail_workspace_inbox_capture($1,$2,$3,$4) result',
              [
                item.workspaceId,
                item.sourceId,
                owned.lease,
                owned.result?.fenceToken,
              ],
            ),
          ).resolves.toEqual({ kind: 'blocked' });
        else {
          await admin.query(
            "update app.workspace_inbox_sources set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
            [item.sourceId],
          );
          expect((await claim(item)).result?.kind).toBe('blocked');
        }
        expect((await claim(item)).result?.kind).toBe('blocked');
        expect(await state(item)).toMatchObject({
          attempts: 10,
          fence: '1',
          captured: false,
          lease_token: null,
          status: 'blocked',
        });
      },
    );
    it('recovers a lost claim acknowledgment after expiry/backoff without accepting a stale owner', async () => {
      const item = await seed();
      const first = await claim(item);
      await admin.query(
        "update app.workspace_inbox_sources set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [item.sourceId],
      );
      expect((await claim(item)).result?.kind).toBe('retry_scheduled');
      expect(await state(item)).toMatchObject({
        attempts: 1,
        deferred: true,
        lease_token: null,
      });
      expect((await claim(item)).result?.kind).toBe('not_due');
      await admin.query(
        "update app.workspace_inbox_sources set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",
        [item.sourceId],
      );
      const next = await claim(item);
      expect(next.result).toEqual({ kind: 'owned', fenceToken: '2' });
      await expect(
        capture(item, first.lease, first.result?.fenceToken),
      ).resolves.toEqual({ kind: 'lost_ownership' });
      await expect(
        capture(item, next.lease, next.result?.fenceToken),
      ).resolves.toEqual({ kind: 'captured', audienceCount: '1' });
      expect(await state(item)).toMatchObject({ attempts: 0, fence: '2' });
    });
    it('fails closed for checksum/changed delivery and never reconstructs a missing source', async () => {
      const item = await seed();
      await expect(
        store().capture({
          ...intent(item),
          delivery: { ...item.delivery, payloadChecksum: 'b'.repeat(64) },
        }),
      ).rejects.toThrow('claim rejected');
      await admin.query(
        "update app.workspace_inbox_sources set checksum=repeat('b',64) where id=$1",
        [item.sourceId],
      );
      await expect(store().capture(intent(item))).rejects.toThrow(
        'claim rejected',
      );
      await admin.query('delete from app.workspace_inbox_sources where id=$1', [
        item.sourceId,
      ]);
      await expect(store().capture(intent(item))).resolves.toEqual({
        kind: 'unavailable',
      });
      expect(
        (
          await admin.query(
            'select id from app.workspace_inbox_sources where id=$1',
            [item.sourceId],
          )
        ).rows,
      ).toEqual([]);
    });
    it('consumes a valid-shape late delivery with both records removed without reconstructing evidence', async () => {
      const item = await seed();
      await admin.query('delete from app.outbox_events where id=$1', [
        item.delivery.outboxEventId,
      ]);
      await admin.query('delete from app.workspace_inbox_sources where id=$1', [
        item.sourceId,
      ]);
      await expect(store().capture(intent(item))).resolves.toEqual({
        kind: 'unavailable',
      });
      // Missing records do not turn malformed supplied input into a valid no-op.
      await expect(
        command(
          item.workspaceId,
          'select app.claim_workspace_inbox_capture($1,$2,$3,$4,$5,$6) result',
          [
            item.workspaceId,
            item.sourceId,
            item.delivery.outboxEventId,
            'invalid',
            item.workerId,
            randomUUID(),
          ],
        ),
      ).rejects.toMatchObject({ code: '22023' });
      await expect(
        store().capture({
          ...intent(item),
          delivery: { ...item.delivery, payloadChecksum: 'invalid' },
        }),
      ).rejects.toThrow();
      const evidence = await admin.query(
        `select
        (select count(*) from app.workspace_inbox_sources where id=$1)::text sources,
        (select count(*) from app.outbox_events where id=$2)::text outbox,
        (select count(*) from app.workspace_inbox_audience where source_id=$1)::text audience,
        (select count(*) from app.workspace_inbox_recipient_state where workspace_id=$3)::text recipients`,
        [item.sourceId, item.delivery.outboxEventId, item.workspaceId],
      );
      expect(evidence.rows).toEqual([
        { sources: '0', outbox: '0', audience: '0', recipients: '0' },
      ]);
    });
    it('rejects missing outbox evidence while a source is retained without changing its ownership', async () => {
      const item = await seed();
      const original = await state(item);
      await admin.query('delete from app.outbox_events where id=$1', [
        item.delivery.outboxEventId,
      ]);
      await expect(claim(item)).rejects.toMatchObject({ code: '22023' });
      expect(await state(item)).toEqual(original);
      expect(
        (
          await admin.query(
            'select user_id from app.workspace_inbox_audience where source_id=$1',
            [item.sourceId],
          )
        ).rows,
      ).toEqual([]);
    });
    it('still rejects corrupt retained delivery when its source has been removed', async () => {
      const item = await seed();
      await admin.query('delete from app.workspace_inbox_sources where id=$1', [
        item.sourceId,
      ]);
      await admin.query(
        `update app.outbox_events set payload=payload||'{"unexpected":true}'::jsonb where id=$1`,
        [item.delivery.outboxEventId],
      );
      await expect(claim(item)).rejects.toMatchObject({ code: '22023' });
      expect(await state(item)).toBeUndefined();
      expect(
        (
          await admin.query(
            'select user_id from app.workspace_inbox_audience where source_id=$1',
            [item.sourceId],
          )
        ).rows,
      ).toEqual([]);
    });
    it('expires evidence without extending the fixed source horizon', async () => {
      const item = await seed();
      await admin.query(
        "update app.workspace_inbox_sources set occurred_at=occurred_at-interval '31 days',expires_at=expires_at-interval '31 days',evidence_until=evidence_until-interval '31 days' where id=$1",
        [item.sourceId],
      );
      await admin.query(
        'update app.workspace_inbox_sources set checksum=app.workspace_inbox_source_checksum(workspace_id,run_id,terminal_event_sequence,kind,occurred_at) where id=$1',
        [item.sourceId],
      );
      await expect(store().capture(intent(item))).resolves.toEqual({
        kind: 'expired',
      });
      expect(await state(item)).toMatchObject({
        status: 'expired',
        captured: false,
        attempts: 0,
      });
    });
    it('does not recapture after a real COMMIT whose driver acknowledgment is delayed past abort', async () => {
      const item = await seed();
      const owned = await claim(item);
      const reached = Promise.withResolvers<undefined>();
      const releaseAck = Promise.withResolvers<undefined>();
      const controller = new AbortController();
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
      const pool = {
        connect: () => Promise.resolve(wrapped),
      } as unknown as Pool;
      const activity = {
        track: <T>(promise: Promise<T>) => promise,
        failDisposal: () => {
          throw new Error('Unexpected disposal failure');
        },
      };
      const transaction = runInboxWriteTransaction(
        pool,
        item.workspaceId,
        controller.signal,
        activity,
        'select app.capture_workspace_inbox_audience($1,$2,$3,$4) result',
        [
          item.workspaceId,
          item.sourceId,
          owned.lease,
          owned.result?.fenceToken,
        ],
        (row) => row,
        'capture',
      );
      await Promise.race([
        reached.promise,
        transaction.then(() => {
          throw new Error('Capture ended before COMMIT barrier');
        }),
      ]);
      controller.abort();
      releaseAck.resolve(undefined);
      expect((await transaction).kind).toBe('uncertain');
      expect(await state(item)).toMatchObject({
        captured: true,
        count: '1',
        attempts: 0,
      });
      expect((await claim(item)).result).toEqual({
        kind: 'captured',
        audienceCount: '1',
      });
    });
    it('allows a successful tenth acquisition to reset the failure budget', async () => {
      const item = await seed();
      await admin.query(
        'update app.workspace_inbox_sources set consecutive_attempts=9 where id=$1',
        [item.sourceId],
      );
      await expect(store().capture(intent(item))).resolves.toEqual({
        kind: 'captured',
        audienceCount: '1',
      });
      expect(await state(item)).toMatchObject({
        attempts: 0,
        fence: '1',
        captured: true,
      });
    });
    it('uses actual source locks to reconcile a paused owner, not lease expiry alone', async () => {
      const item = await seed();
      const owned = await claim(item);
      // Shorten ONLY this arranged fixture lease; not a capacity/budget proof.
      await admin.query(
        "update app.workspace_inbox_sources set lease_expires_at=clock_timestamp()+interval '2 seconds' where id=$1",
        [item.sourceId],
      );
      const client = await worker.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          item.workspaceId,
        ]);
        await client.query(
          'select app.capture_workspace_inbox_audience($1,$2,$3,$4)',
          [
            item.workspaceId,
            item.sourceId,
            owned.lease,
            owned.result?.fenceToken,
          ],
        );
        await client.query('select pg_sleep(2.1)');
        const contender = claim(item);
        await client.query('commit');
        expect((await contender).result).toEqual({
          kind: 'captured',
          audienceCount: '1',
        });
      } catch (error: unknown) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      expect(await state(item)).toMatchObject({
        attempts: 0,
        fence: '1',
        captured: true,
        count: '1',
      });
      expect(
        (
          await admin.query(
            'select user_id from app.workspace_inbox_audience where source_id=$1',
            [item.sourceId],
          )
        ).rows,
      ).toHaveLength(1);
    }, 10_000);
    it('rolls back audience and marker when absolute expiry passes during audience insertion', async () => {
      const item = await seed(1);
      const owned = await claim(item);
      // Fixed horizons/checksum remain valid. The trigger waits until the actual
      // stored expiry, rather than assuming a particular machine execution speed.
      await admin.query(
        `CREATE FUNCTION app.test_inbox_capture_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
         DECLARE expiry timestamptz;
         BEGIN
           SELECT expires_at INTO expiry FROM app.workspace_inbox_sources WHERE id=NEW.source_id;
           PERFORM pg_sleep(greatest(0,extract(epoch from expiry-clock_timestamp()))+0.05);
           RETURN NEW;
         END $$`,
      );
      await admin.query(
        `CREATE TRIGGER test_inbox_capture_expiry BEFORE INSERT ON app.workspace_inbox_audience FOR EACH ROW WHEN (NEW.source_id='${item.sourceId}'::uuid) EXECUTE FUNCTION app.test_inbox_capture_expiry()`,
      );
      try {
        await admin.query(
          `with horizon as (select clock_timestamp()+interval '1 second' expiry)
           update app.workspace_inbox_sources set
             occurred_at=expiry-interval '720 hours',expires_at=expiry,
             evidence_until=expiry+interval '1440 hours',
             checksum=app.workspace_inbox_source_checksum(workspace_id,run_id,terminal_event_sequence,kind,expiry-interval '720 hours')
           from horizon where id=$1`,
          [item.sourceId],
        );
        await expect(
          capture(item, owned.lease, owned.result?.fenceToken),
        ).rejects.toMatchObject({ code: '57014' });
        expect(await state(item)).toMatchObject({
          captured: false,
          count: '0',
          attempts: 1,
          lease_token: owned.lease,
        });
        expect(
          (
            await admin.query(
              'select user_id from app.workspace_inbox_audience where source_id=$1',
              [item.sourceId],
            )
          ).rows,
        ).toEqual([]);
        expect(
          await command(
            item.workspaceId,
            'select app.fail_workspace_inbox_capture($1,$2,$3,$4) result',
            [
              item.workspaceId,
              item.sourceId,
              owned.lease,
              owned.result?.fenceToken,
            ],
          ),
        ).toEqual({ kind: 'expired' });
        expect(await state(item)).toMatchObject({
          status: 'expired',
          captured: false,
          count: '0',
          lease_token: null,
        });
      } finally {
        await admin.query(
          'DROP TRIGGER test_inbox_capture_expiry ON app.workspace_inbox_audience',
        );
        await admin.query('DROP FUNCTION app.test_inbox_capture_expiry()');
      }
    }, 10_000);
    it('enforces actual statement timeout, rolls back the complete audience, and schedules internal failure recovery', async () => {
      const item = await seed();
      await admin.query(
        'CREATE FUNCTION app.test_inbox_capture_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$',
      );
      await admin.query(
        `CREATE TRIGGER test_inbox_capture_delay BEFORE INSERT ON app.workspace_inbox_audience FOR EACH ROW WHEN (NEW.source_id='${item.sourceId}'::uuid) EXECUTE FUNCTION app.test_inbox_capture_delay()`,
      );
      try {
        await expect(store().capture(intent(item))).resolves.toEqual({
          kind: 'retry_scheduled',
        });
        expect(await state(item)).toMatchObject({
          attempts: 1,
          captured: false,
          count: '0',
          lease_token: null,
          deferred: true,
        });
        expect(
          (
            await admin.query(
              'select user_id from app.workspace_inbox_audience where source_id=$1',
              [item.sourceId],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await admin.query(
          'DROP TRIGGER test_inbox_capture_delay ON app.workspace_inbox_audience',
        );
        await admin.query('DROP FUNCTION app.test_inbox_capture_delay()');
      }
    }, 15_000);
  },
);
