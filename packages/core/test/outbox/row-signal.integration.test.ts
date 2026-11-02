import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { createTransportTestEnvironment } from './transport.support.js';

const transport = createTransportTestEnvironment();
const SIGNAL = 'outbox_rows';
/** Comes after anything already committed, so "no signal" doesn't need a sleep. */
const CAUGHT_UP = 'row_signal_caught_up';

const adminUrl = (): string => {
  const url = new URL(
    process.env.DATABASE_ADMIN_URL ??
      'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
  );
  url.pathname = new URL(transport.migrationUrl).pathname;
  return url.toString();
};

describe('the signal an insert into the outbox sends', () => {
  let writer: Client;
  let listener: Client;
  let received: string[];
  let caughtUp: PromiseWithResolvers<undefined>;

  beforeAll(async () => {
    await transport.initialize();
    writer = new Client({ connectionString: adminUrl() });
    await writer.connect();
  });

  afterAll(async () => {
    await writer.end();
    await transport.close();
  });

  beforeEach(async () => {
    received = [];
    caughtUp = Promise.withResolvers();
    listener = new Client({ connectionString: adminUrl() });
    await listener.connect();
    listener.on('notification', ({ channel, payload }) => {
      if (channel === CAUGHT_UP) caughtUp.resolve(undefined);
      else received.push(`${channel}:${payload ?? ''}`);
    });
    await listener.query(`listen ${SIGNAL}`);
    await listener.query(`listen ${CAUGHT_UP}`);
  });

  afterEach(async () => {
    await listener.end();
  });

  const signalsSoFar = async (): Promise<readonly string[]> => {
    await writer.query(`select pg_notify('${CAUGHT_UP}', '')`);
    await caughtUp.promise;
    return received;
  };

  const insertRows = (count: number) =>
    writer.query(
      `insert into app.outbox_events (
         id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum
       )
       select gen_random_uuid(),$1,'row-signal','row-signal',gen_random_uuid(),'{}',$2
         from generate_series(1, $3::int)`,
      [transport.workspaceA, transport.checksumA, count],
    );

  // The worker's scans run these many times a second, with nothing to say.
  it('stays quiet for an insert of no rows', async () => {
    await insertRows(0);

    await expect(signalsSoFar()).resolves.toEqual([]);
  });

  it('signals once for three rows in one statement', async () => {
    await insertRows(3);

    await expect(signalsSoFar()).resolves.toEqual([`${SIGNAL}:`]);
  });

  it('signals for each transaction that adds rows', async () => {
    await insertRows(1);
    await insertRows(1);

    await expect(signalsSoFar()).resolves.toEqual([`${SIGNAL}:`, `${SIGNAL}:`]);
  });

  it('stays quiet until the rows are committed, and for rows rolled back', async () => {
    await writer.query('begin');
    await insertRows(1);
    await writer.query('rollback');

    await expect(signalsSoFar()).resolves.toEqual([]);
  });

  it('stays quiet when a row changes, since only a new one needs finding', async () => {
    const id = randomUUID();
    await writer.query(
      `insert into app.outbox_events (
         id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum
       ) values ($1,$2,'row-signal','row-signal',$1,'{}',$3)`,
      [id, transport.workspaceA, transport.checksumA],
    );
    await signalsSoFar();
    received.length = 0;
    caughtUp = Promise.withResolvers();

    await writer.query(
      `update app.outbox_events set updated_at = now() where id = $1`,
      [id],
    );

    await expect(signalsSoFar()).resolves.toEqual([]);
  });
});
