import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { insertOutboxEvent } from '../../../src/outbox/events.repository.js';
import { settleOverdueDeliveries } from '../../../src/outbox/overdue-deliveries.repository.js';
import { inboxReceipts, outboxEvents } from '../../../src/schema.js';
import {
  apiDatabase,
  dispatcher,
  dispatcherUrl,
  enabledJobNames,
  outboxInput,
  workspaceA,
} from './fixture.js';

const publish = async (): Promise<string> => {
  const input = outboxInput();
  await apiDatabase.withWorkspace(workspaceA, (transaction) =>
    insertOutboxEvent(transaction, {
      ...input,
      availableAt: new Date(0),
    }).then(() => undefined),
  );
  const claimed = await dispatcher.claimBatch({
    enabledJobNames,
    leaseDurationMillis: 30_000,
    leaseOwner: 'overdue-proof',
    leaseToken: randomUUID(),
    limit: 100,
  });
  const event = claimed.events.find(({ id }) => id === input.id);
  if (event === undefined) throw new Error('Expected the event to be claimed');
  await dispatcher.markPublished(event.id, event.leaseToken);
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

  it('never gives one row to two scanners', async () => {
    const id = await publish();
    await makeDue(id);

    const [first, second] = await Promise.all([settle(), settle()]);

    expect(first.asked.length + second.asked.length).toBe(1);
    expect((await read(id)).redeliveries).toBe(1);
  });
}
