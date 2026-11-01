import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';

import {
  createSystemMailDeliveryStore,
  createSystemMailEnqueueStore,
} from '../../src/server.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const appUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const databaseName = `pertexo_test_system_mail_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  databaseName,
  ownerRole: 'pertexo_owner',
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
});
const url = (base: string) => {
  const value = new URL(base);
  value.pathname = `/${databaseName}`;
  return value.toString();
};

const SEALED = {
  ciphertext: 'sealed',
  nonce: 'nonce',
  tag: 'tag',
  keyVersion: 'v1',
};
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let admin!: Pool;
let store!: ReturnType<typeof createSystemMailDeliveryStore>;
let enqueue!: ReturnType<typeof createSystemMailEnqueueStore>;

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    connectionString: url(migrationUrl),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  admin = new Pool({ connectionString: url(adminUrl), max: 2 });
  const config = parseDatabaseConfig({
    connectionString: url(appUrl),
    max: 2,
  });
  store = createSystemMailDeliveryStore(config);
  enqueue = createSystemMailEnqueueStore(config);
}, 60_000);

afterAll(async () => {
  await store.close();
  await enqueue.close();
  await admin.end();
  await fixture.drop();
}, 30_000);

beforeEach(async () => {
  await admin.query('delete from app.system_mail_deliveries');
});

async function queue(
  fields: Readonly<Record<string, unknown>> = {},
  purpose: 'verification' | 'workspace_notice' = 'verification',
): Promise<string> {
  const id = randomUUID();
  await enqueue.enqueue({
    id,
    purpose,
    expiresAt: new Date(Date.now() + 48 * HOUR),
    sealedPayload: SEALED,
  });
  const columns = Object.keys(fields);
  if (columns.length > 0)
    await admin.query(
      `update app.system_mail_deliveries
          set ${columns.map((name, index) => `${name}=$${String(index + 2)}`).join(',')}
        where id=$1`,
      [id, ...Object.values(fields)],
    );
  return id;
}

async function row(id: string) {
  const result = await admin.query<{
    status: string;
    attempt_count: number;
    payload_ciphertext: string | null;
    provider_reference: string | null;
    failure_code: string | null;
    next_attempt_at: Date;
    lease_expires_at: Date | null;
    lease_token: string | null;
  }>(
    `select status,attempt_count,payload_ciphertext,provider_reference,failure_code,
            next_attempt_at,lease_expires_at,lease_token
       from app.system_mail_deliveries where id=$1`,
    [id],
  );
  const found = result.rows[0];
  if (found === undefined) throw new Error('Mail row missing');
  return found;
}

const claim = (limit = 10) => store.claim({ workerId: 'mail-test', limit });

async function claimOne(id: string) {
  const claims = await claim();
  const found = claims.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error('Expected a claim');
  return found;
}

const identity = (claimed: Awaited<ReturnType<typeof claimOne>>) => ({
  id: claimed.id,
  leaseToken: claimed.leaseToken,
  leaseGeneration: claimed.leaseGeneration,
});

describe('claiming system mail', () => {
  it('takes everything but workspace notices first, then the oldest due', async () => {
    const notice = await queue(
      { next_attempt_at: new Date(Date.now() - 2 * HOUR) },
      'workspace_notice',
    );
    const newer = await queue({
      next_attempt_at: new Date(Date.now() - MINUTE),
    });
    const older = await queue({ next_attempt_at: new Date(Date.now() - HOUR) });

    const claims = await claim();

    expect(claims.map(({ id }) => id)).toEqual([older, newer, notice]);
  });

  it('leaves a notice behind when a smaller batch fills with other mail', async () => {
    const notice = await queue(
      { next_attempt_at: new Date(Date.now() - 2 * HOUR) },
      'workspace_notice',
    );
    const other = await queue();

    const claims = await claim(1);

    expect(claims.map(({ id }) => id)).toEqual([other]);
    expect((await row(notice)).status).toBe('queued');
  });

  it.each([
    ['at twelve attempts', { attempt_count: 12 }],
    [
      'past 24 hours',
      { created_at: new Date(Date.now() - 24 * HOUR - MINUTE) },
    ],
    [
      'past its expiry',
      {
        expires_at: new Date(Date.now() - MINUTE),
        created_at: new Date(Date.now() - HOUR),
      },
    ],
    ['not yet due', { next_attempt_at: new Date(Date.now() + MINUTE) }],
  ])('refuses a row %s', async (_name, fields) => {
    await queue(fields);

    expect(await claim()).toEqual([]);
  });

  it('claims a row just inside 24 hours, and one at eleven attempts to the twelfth', async () => {
    const inside = await queue({
      created_at: new Date(Date.now() - 24 * HOUR + MINUTE),
    });
    const eleven = await queue({ attempt_count: 11 });

    const claims = await claim();

    expect(claims.map(({ id }) => id).sort()).toEqual([inside, eleven].sort());
    expect((await row(eleven)).attempt_count).toBe(12);
    await expect(
      admin.query(
        'update app.system_mail_deliveries set attempt_count=13 where id=$1',
        [eleven],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('holds a claim for a 60-second lease and refuses it until that ends', async () => {
    const id = await queue();

    await claimOne(id);
    const leased = await row(id);
    const leaseSeconds =
      ((leased.lease_expires_at?.getTime() ?? 0) - Date.now()) / 1_000;
    expect(leaseSeconds).toBeGreaterThan(50);
    expect(leaseSeconds).toBeLessThanOrEqual(60);
    expect(await claim()).toEqual([]);

    await admin.query(
      `update app.system_mail_deliveries
          set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1`,
      [id],
    );
    expect((await claim()).map((claimed) => claimed.id)).toEqual([id]);
  });

  it('calls a claim recovered only when the row was left unknown', async () => {
    const id = await queue();

    const first = await claimOne(id);
    expect(first.recoveredUnknown).toBe(false);

    await admin.query(
      `update app.system_mail_deliveries
          set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1`,
      [id],
    );
    const second = await claimOne(id);
    expect(second.recoveredUnknown).toBe(true);
    expect(second.leaseGeneration).toBe(first.leaseGeneration + 1);
    expect(second.leaseToken).not.toBe(first.leaseToken);
  });
});

describe('settling system mail', () => {
  it('keeps the payload on a retry inside the limits, with its time', async () => {
    const id = await queue();
    const claimed = await claimOne(id);
    const retryAt = new Date(Date.now() + MINUTE);

    await expect(
      store.settle({ ...identity(claimed), outcome: 'retry', retryAt }),
    ).resolves.toBe(true);

    expect(await row(id)).toMatchObject({
      status: 'retry',
      payload_ciphertext: 'sealed',
      next_attempt_at: retryAt,
      lease_token: null,
    });
  });

  it.each([
    ['at twelve attempts', { attempt_count: 11 }, MINUTE],
    ['past 24 hours', {}, 25 * HOUR],
    [
      'past its expiry',
      { expires_at: new Date(Date.now() + 2 * MINUTE) },
      3 * MINUTE,
    ],
  ])(
    'gives up a retry %s, dropping the payload',
    async (_name, fields, retryIn) => {
      const id = await queue(fields);
      const claimed = await claimOne(id);

      await expect(
        store.settle({
          ...identity(claimed),
          outcome: 'retry',
          retryAt: new Date(Date.now() + retryIn),
        }),
      ).resolves.toBe(true);

      expect(await row(id)).toMatchObject({
        status: 'reconciliation_required',
        payload_ciphertext: null,
      });
    },
  );

  it('cannot write a retry without its time', async () => {
    const id = await queue();
    const claimed = await claimOne(id);
    const before = await row(id);

    // @ts-expect-error A retry always says when: the type has no such settlement.
    const noTime = store.settle({ ...identity(claimed), outcome: 'retry' });

    await expect(noTime).rejects.toBeDefined();
    expect(await row(id)).toEqual(before);
  });

  it.each([
    ['token', { leaseToken: randomUUID() }],
    ['generation', { leaseGeneration: 999 }],
  ])('changes nothing for a wrong lease %s', async (_name, wrong) => {
    const id = await queue();
    const claimed = await claimOne(id);
    const before = await row(id);

    await expect(
      store.settle({
        ...identity(claimed),
        ...wrong,
        outcome: 'submitted',
        providerReference: 'late',
      }),
    ).resolves.toBe(false);

    expect(await row(id)).toEqual(before);
  });

  it('cuts the provider reference at 512 and the failure code at 128', async () => {
    const id = await queue();
    const claimed = await claimOne(id);

    await store.settle({
      ...identity(claimed),
      outcome: 'failed',
      providerReference: 'p'.repeat(600),
      failureCode: 'f'.repeat(200),
    });

    const settled = await row(id);
    expect(settled.provider_reference).toBe('p'.repeat(512));
    expect(settled.failure_code).toBe('f'.repeat(128));
    expect(settled.payload_ciphertext).toBeNull();
  });
});
