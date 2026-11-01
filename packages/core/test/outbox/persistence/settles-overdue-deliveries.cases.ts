import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { DELIVERY_CONSUMER } from '../../../src/outbox/delivery-consumers.js';
import { insertOutboxEvent } from '@pertexo/database/primitives';
import { settleOverdueDeliveries } from '../../../src/outbox/overdue-deliveries.repository.js';
import { inboxReceipts, outboxEvents } from '@pertexo/database/schema';
import {
  apiDatabase,
  dispatcher,
  dispatcherUrl,
  enabledJobNames,
  operator,
  outboxInput,
  workspaceA,
} from './fixture.js';

// A first job only leaves with a capacity reservation for a real run.
const KINDS_THAT_NEED_NO_RUN = Object.keys(DELIVERY_CONSUMER).filter(
  (jobName) => jobName !== 'advance-workflow-run',
);

const redeliver = async (
  id: string,
  jobNames: readonly string[] = enabledJobNames,
) => {
  const claimed = await dispatcher.claimBatch({
    enabledJobNames: jobNames,
    leaseDurationMillis: 30_000,
    leaseOwner: 'overdue-proof',
    leaseToken: randomUUID(),
    limit: 100,
  });
  const event = claimed.events.find((candidate) => candidate.id === id);
  if (event === undefined) throw new Error('Expected the event to be claimed');
  await dispatcher.markPublished(event.id, event.leaseToken);
  return event;
};

const publish = async (
  jobName: string = enabledJobNames[0] ?? '',
): Promise<string> => {
  const input = { ...outboxInput(), jobName };
  await apiDatabase.withWorkspace(workspaceA, (transaction) =>
    insertOutboxEvent(transaction, {
      ...input,
      availableAt: new Date(0),
    }).then(() => undefined),
  );
  await redeliver(input.id, [jobName]);
  return input.id;
};

const read = async (id: string) => {
  const [row] = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
    db.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
  );
  if (row === undefined) throw new Error('Expected the event');
  return row;
};

export function registerSettlesOverdueDeliveries(): void {
  // The role the scanner runs as, so this also proves what that role may do.
  let scanner: Pool;
  beforeAll(() => {
    scanner = new Pool({ connectionString: dispatcherUrl, max: 2 });
  });
  afterAll(() => scanner.end());

  const makeDue = (id: string, redeliveries = 0) =>
    scanner.query(
      `update app.outbox_events
          set delivery_due_at=clock_timestamp()-interval '1 second', redeliveries=$2
        where id=$1`,
      [id, redeliveries],
    );
  const settle = () => settleOverdueDeliveries(scanner, 100);

  it('gives every published job kind a time to be confirmed by', async () => {
    const id = await publish();
    const { deliveryDueAt, publishedAt } = await read(id);
    expect(publishedAt).not.toBeNull();
    expect(deliveryDueAt?.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(deliveryDueAt?.getTime()).toBeLessThan(Date.now() + 70_000);
  });

  it.each(KINDS_THAT_NEED_NO_RUN)(
    'gives a published %s a time to be confirmed by',
    async (jobName) => {
      const { deliveryDueAt } = await read(await publish(jobName));
      expect(deliveryDueAt).not.toBeNull();
    },
  );

  it('leaves a job alone until its time has passed', async () => {
    const id = await publish();
    expect((await settle()).settled).toBe(0);
    expect((await read(id)).redeliveries).toBe(0);
  });

  it('sends an unconfirmed job back to the dispatcher as the same row', async () => {
    const id = await publish();
    const before = await read(id);
    await makeDue(id);

    const { asked } = await settle();

    expect(asked).toMatchObject([
      { outboxEventId: id, redeliveries: 1, gaveUp: false },
    ]);
    const after = await read(id);
    expect(after).toMatchObject({
      publishedAt: null,
      deliveryDueAt: null,
      failedAt: null,
      redeliveries: 1,
      payloadChecksum: before.payloadChecksum,
    });
    expect(after.payload).toEqual(before.payload);
  });

  it('allows the redelivery twice as long, and carries its count to the dispatcher', async () => {
    const id = await publish();
    await makeDue(id);
    await settle();

    const claimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'overdue-proof',
      leaseToken: randomUUID(),
      limit: 100,
    });
    const event = claimed.events.find((candidate) => candidate.id === id);
    expect(event?.redeliveries).toBe(1);
    if (event === undefined) throw new Error('Expected the redelivery');
    await dispatcher.markPublished(event.id, event.leaseToken);

    const { deliveryDueAt } = await read(id);
    expect(deliveryDueAt?.getTime()).toBeGreaterThan(Date.now() + 110_000);
    expect(deliveryDueAt?.getTime()).toBeLessThan(Date.now() + 130_000);
  });

  it('asks again at most once an hour, however often it has asked', async () => {
    const id = await publish();
    await makeDue(id, 8);
    await settle();

    await redeliver(id);

    const { deliveryDueAt } = await read(id);
    expect(deliveryDueAt?.getTime()).toBeGreaterThan(Date.now() + 3_590_000);
    expect(deliveryDueAt?.getTime()).toBeLessThan(Date.now() + 3_610_000);
  });

  it('stops watching a job as soon as its consumer has a receipt', async () => {
    const id = await publish();
    const { payloadChecksum } = await read(id);
    await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.insert(inboxReceipts).values({
        consumerName: 'workflow-coordinator',
        messageId: id,
        workspaceId: workspaceA,
        payloadChecksum,
      }),
    );
    await makeDue(id);

    const { asked, settled } = await settle();

    expect({ asked, settled }).toEqual({ asked: [], settled: 1 });
    const after = await read(id);
    expect(after.deliveryDueAt).toBeNull();
    expect(after.publishedAt).not.toBeNull();
    expect(after.redeliveries).toBe(0);
  });

  it('ends a job that never confirms where an operator can see it', async () => {
    const id = await publish();
    await makeDue(id, 30);

    const { asked } = await settle();

    expect(asked).toMatchObject([{ outboxEventId: id, gaveUp: true }]);
    expect(await read(id)).toMatchObject({
      publishedAt: null,
      lastErrorCode: 'delivery.never_confirmed',
      redeliveries: 30,
    });
    expect((await read(id)).failedAt).not.toBeNull();
  });

  it('delivers again one short of the limit', async () => {
    const id = await publish();
    await makeDue(id, 29);

    const { asked } = await settle();

    expect(asked).toMatchObject([
      { outboxEventId: id, redeliveries: 30, gaveUp: false },
    ]);
    expect((await read(id)).failedAt).toBeNull();
  });

  it('lets an operator send a job given up on, under a job ID Redis has not seen', async () => {
    const id = await publish();
    await makeDue(id, 30);
    await settle();

    await expect(
      operator.redispatchFailedOutbox({
        actorRef: 'overdue-proof',
        commandId: randomUUID(),
        dryRun: false,
        outboxEventId: id,
        reason: 'fixed what stopped it being confirmed',
        workspaceId: workspaceA,
      }),
    ).resolves.toMatchObject({ outcome: 'redispatched' });

    const event = await redeliver(id);
    expect(event.redeliveries).toBe(31);
    expect((await read(id)).failedAt).toBeNull();
  });

  it('leaves alone a row that failed to publish', async () => {
    const id = await publish();
    await scanner.query(
      `update app.outbox_events
          set published_at=null, failed_at=clock_timestamp(),
              delivery_due_at=clock_timestamp()-interval '1 second'
        where id=$1`,
      [id],
    );
    const before = await read(id);

    const { asked } = await settle();

    expect(asked).toEqual([]);
    expect(await read(id)).toEqual(before);
  });

  it('gives a row held by someone else to one scanner, once it is free', async () => {
    const id = await publish();
    await makeDue(id);
    const holder = new Pool({ connectionString: dispatcherUrl, max: 1 });
    const client = await holder.connect();
    let scans: Awaited<ReturnType<typeof settle>>[];
    try {
      await client.query('begin');
      await client.query(
        'select 1 from app.outbox_events where id=$1 for update',
        [id],
      );
      // Both have read the row as due by now, if a read is all they do first.
      const both = Promise.all([settle(), settle()]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await client.query('commit');
      scans = await both;
    } finally {
      client.release();
      await holder.end();
    }
    scans.push(await settle());

    const askedOf = scans.flatMap(({ asked }) =>
      asked.filter(({ outboxEventId }) => outboxEventId === id),
    );
    expect(askedOf).toHaveLength(1);
    expect((await read(id)).redeliveries).toBe(1);
  });

  it('never gives one row to two scanners', async () => {
    const id = await publish();
    await makeDue(id);

    const [first, second] = await Promise.all([settle(), settle()]);

    expect(first.asked.length + second.asked.length).toBe(1);
    expect((await read(id)).redeliveries).toBe(1);
  });
}
