import { createHash, randomUUID } from 'node:crypto';

import {
  createDatabaseRuntime,
  acquireDatabasePool,
} from '@pertexo/database/platform';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  maintenanceUrl,
  adminUrl,
  parseDatabaseConfig,
  retention,
  workspaceId,
  withDatabase,
} from '../lifecycle/retention.support.js';
import { DELIVERY_CONSUMER } from '../../src/outbox/delivery-consumers.js';
import { dateUndatedDeliveries } from '../../src/outbox/overdue-deliveries.repository.js';

const DAY = 86_400_000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY);
const checksum = () => createHash('sha256').update(randomUUID()).digest('hex');
const RECEIPT_CONSUMER = Object.values(DELIVERY_CONSUMER)[0] ?? '';

let seeder!: Client;

beforeAll(async () => {
  seeder = new Client({ connectionString: withDatabase(adminUrl) });
  await seeder.connect();
  // Only for seeding: admission's triggers guard how a run is started, which the
  // rules here don't read. The deletes are the maintenance role's, with all of it on.
  await seeder.query(`set session_replication_role=replica`);
});

afterAll(async () => {
  await seeder.end();
});

type EventClock = Readonly<{
  published_at?: Date;
  failed_at?: Date;
  delivery_due_at?: Date;
  aggregate_type?: string;
  aggregate_id?: string;
}>;

async function seedEvent(clock: EventClock): Promise<string> {
  const id = randomUUID();
  await seeder.query(
    `insert into app.outbox_events (
       id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,
       published_at,failed_at,last_error_code,delivery_due_at
     ) values ($1,$2,'deliver-workspace-invitation',$3,$4,'{}',$5,$6,$7,$8,$9)`,
    [
      id,
      workspaceId,
      clock.aggregate_type ?? 'workspace-invitation',
      clock.aggregate_id ?? randomUUID(),
      checksum(),
      clock.published_at ?? null,
      clock.failed_at ?? null,
      clock.failed_at === undefined ? null : 'test.failed',
      clock.delivery_due_at ?? null,
    ],
  );
  return id;
}

let nextTicket = 0;

async function seedRun(status: string): Promise<string> {
  const id = randomUUID();
  await seeder.query(
    `insert into app.workflow_runs
       (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,admission_ticket,
        started_at,completed_at)
     values($1,$2,$3,$4,'manual',$5::varchar,$6,
       case when $5::varchar = 'succeeded' then now() end,
       case when $5::varchar = 'succeeded' then now() end)`,
    [id, workspaceId, randomUUID(), randomUUID(), status, (nextTicket += 1)],
  );
  return id;
}

async function holdSlot(eventId: string, runId: string): Promise<void> {
  await seeder.query(
    `insert into app.workflow_run_active_admissions
       (workspace_id,workflow_run_id,outbox_event_id)
     values ($1,$2,$3)`,
    [workspaceId, runId, eventId],
  );
}

async function seedReceipt(messageId: string, receivedAt: Date): Promise<void> {
  await seeder.query(
    `insert into app.inbox_receipts
       (consumer_name,message_id,workspace_id,payload_checksum,received_at)
     values ($1,$2,$3,$4,$5)`,
    [RECEIPT_CONSUMER, messageId, workspaceId, checksum(), receivedAt],
  );
}

const eventExists = async (id: string): Promise<boolean> =>
  (await seeder.query(`select 1 from app.outbox_events where id = $1`, [id]))
    .rows.length === 1;
const receiptExists = async (messageId: string): Promise<boolean> =>
  (
    await seeder.query(
      `select 1 from app.inbox_receipts where message_id = $1`,
      [messageId],
    )
  ).rows.length === 1;

/** Every page of every rule, as the worker's passes would come to. */
async function enforceUntilDone(): Promise<void> {
  for (let more = true; more;) ({ more } = await retention.enforce());
}

describe('what outbox retention keeps past a row’s window', () => {
  describe.each([
    {
      kind: 'published',
      past: { published_at: daysAgo(31) },
    },
    {
      kind: 'failed',
      past: { failed_at: daysAgo(91) },
    },
  ])('a $kind row', ({ past }) => {
    it('goes once nothing leans on it', async () => {
      const id = await seedEvent(past);

      await enforceUntilDone();

      await expect(eventExists(id)).resolves.toBe(false);
    });

    // Somebody's promise: a published row is waiting for a receipt, and a failed
    // run job for its replacement.
    it('stays while it is still watched', async () => {
      const id = await seedEvent({ ...past, delivery_due_at: daysAgo(-1) });

      await enforceUntilDone();

      await expect(eventExists(id)).resolves.toBe(true);
    });

    // The foreign key cascades, so deleting this row would free the run's slot.
    it('stays while an admission holds it, and the admission with it', async () => {
      const runId = await seedRun('running');
      const id = await seedEvent(past);
      await holdSlot(id, runId);

      await enforceUntilDone();

      await expect(eventExists(id)).resolves.toBe(true);
      const held = await seeder.query(
        `select 1 from app.workflow_run_active_admissions where outbox_event_id = $1`,
        [id],
      );
      expect(held.rows).toHaveLength(1);

      await seeder.query(
        `delete from app.workflow_run_active_admissions where outbox_event_id = $1`,
        [id],
      );
      await seeder.query(
        `update app.workflow_runs set status = 'succeeded',
           started_at = now(), completed_at = now() where id = $1`,
        [runId],
      );
      await enforceUntilDone();
      await expect(eventExists(id)).resolves.toBe(false);
    });

    // Capacity's SQL functions compare a run's rows until it finishes.
    it.each(['queued', 'running', 'waiting'])(
      'stays while its run is %s',
      async (status) => {
        const runId = await seedRun(status);
        const id = await seedEvent({
          ...past,
          aggregate_type: 'workflow-run',
          aggregate_id: runId,
        });

        await enforceUntilDone();

        await expect(eventExists(id)).resolves.toBe(true);
      },
    );

    it('goes when its run has finished', async () => {
      const runId = await seedRun('succeeded');
      const id = await seedEvent({
        ...past,
        aggregate_type: 'workflow-run',
        aggregate_id: runId,
      });

      await enforceUntilDone();

      await expect(eventExists(id)).resolves.toBe(false);
    });

    // A running run's id on another kind of row says nothing about that row.
    it('goes when only an unrelated row names a live run', async () => {
      const runId = await seedRun('running');
      const id = await seedEvent({
        ...past,
        aggregate_type: 'workspace-invitation',
        aggregate_id: runId,
      });

      await enforceUntilDone();

      await expect(eventExists(id)).resolves.toBe(false);
    });
  });

  it('gives a failed row longer on the stuck-work list than a published one', async () => {
    const failedInside = await seedEvent({ failed_at: daysAgo(31) });
    const publishedPast = await seedEvent({ published_at: daysAgo(31) });

    await enforceUntilDone();

    await expect(eventExists(failedInside)).resolves.toBe(true);
    await expect(eventExists(publishedPast)).resolves.toBe(false);
  });
});

describe('what happens to a delivery’s receipt', () => {
  // A published event with no receipt reads as a lost job.
  it('stays while its event does, so old work is not sent round again', async () => {
    const eventId = await seedEvent({ published_at: daysAgo(10) });
    await seedReceipt(eventId, daysAgo(31));

    await enforceUntilDone();

    await expect(receiptExists(eventId)).resolves.toBe(true);

    const config = parseDatabaseConfig({
      connectionString: maintenanceUrl,
      max: 1,
    });
    const runtime = createDatabaseRuntime(config, { role: 'worker' });
    try {
      await dateUndatedDeliveries(
        acquireDatabasePool(config, runtime).pool,
        100,
      );
    } finally {
      await runtime.close();
    }
    const event = await seeder.query<{ watched: boolean }>(
      `select delivery_due_at is not null as watched
         from app.outbox_events where id = $1`,
      [eventId],
    );
    expect(event.rows[0]?.watched).toBe(false);
  });

  it('goes with its event once both are past the window', async () => {
    const eventId = await seedEvent({ published_at: daysAgo(31) });
    await seedReceipt(eventId, daysAgo(31));

    await enforceUntilDone();

    await expect(eventExists(eventId)).resolves.toBe(false);
    await expect(receiptExists(eventId)).resolves.toBe(false);
  });

  it('stays out its own window after its event has gone', async () => {
    const messageId = randomUUID();
    await seedReceipt(messageId, daysAgo(29));

    await enforceUntilDone();

    await expect(receiptExists(messageId)).resolves.toBe(true);
  });

  it('outlasts an event an admission keeps past the window', async () => {
    const runId = await seedRun('running');
    const eventId = await seedEvent({ published_at: daysAgo(31) });
    await holdSlot(eventId, runId);
    await seedReceipt(eventId, daysAgo(31));

    await enforceUntilDone();

    await expect(eventExists(eventId)).resolves.toBe(true);
    await expect(receiptExists(eventId)).resolves.toBe(true);
  });
});
