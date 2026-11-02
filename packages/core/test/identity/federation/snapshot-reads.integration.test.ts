import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useIdentityCommandDatabase } from '../command.support.js';

const db = useIdentityCommandDatabase('fed_snapshot');
const key = () => randomUUID();
const renewedChallenge = 'r'.repeat(43);

let holders: Pool;

beforeAll(async () => {
  const [row] = await db.asAdmin<{ name: string }>(
    'select current_database() as name',
  );
  const url = new URL(
    process.env.DATABASE_ADMIN_URL ??
      'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
  );
  url.pathname = `/${String(row?.name)}`;
  holders = new Pool({ connectionString: url.toString(), max: 1 });
});
afterAll(() => holders.end());

async function setup() {
  const owner = await db.user('Owner'),
    workspaceId = await db.workspace(owner.id);
  const scope = { workspaceId, actorId: owner.id };
  await db.federation().createOrganization({
    ...scope,
    name: 'Before',
    idempotencyKey: key(),
  });
  const added = await db.federation().createDomain({
    ...scope,
    domain: `${randomUUID()}.example.test`,
    expectedRevision: 1,
    idempotencyKey: key(),
  });
  const domain = added.organization?.domains[0];
  const organization = added.organization;
  if (domain === undefined || organization === null)
    throw new Error('Domain missing');
  return { scope, domain, organization };
}

type Query = (text: string, values?: unknown[]) => Promise<unknown>;

const blockedOnLock = () =>
  expect
    .poll(
      async () => {
        const [row] = await db.asAdmin<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity
           where datname=current_database() and wait_event_type='Lock'`,
        );
        return Number(row?.count);
      },
      { timeout: 10_000, interval: 25 },
    )
    .toBe(1);

/**
 * Holds `table` so a read stops at its first look there, having already taken
 * its snapshot, then commits a change the read must not see.
 */
async function changeDuringRead<T>(
  table: string,
  read: () => Promise<T>,
  change: (query: Query) => Promise<unknown>,
): Promise<T> {
  const holder = await holders.connect();
  try {
    await holder.query('begin');
    await holder.query(`lock table ${table} in access exclusive mode`);
    const reading = read();
    await blockedOnLock();
    await change((text, values) => holder.query(text, values));
    await holder.query('commit');
    return await reading;
  } catch (error: unknown) {
    await holder.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
}

describe('the federation reads see one moment', () => {
  it('settings: a domain added mid-read stays out, as the revision it read says', async () => {
    const f = await setup();
    const settings = await changeDuringRead(
      'app.auth_domains',
      () => db.federation().settings(f.scope),
      (query) =>
        query(
          `insert into app.auth_domains(id,organization_id,domain,challenge,challenge_expires_at)
           values($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`,
          [
            randomUUID(),
            f.organization.id,
            `${randomUUID()}.example.test`,
            renewedChallenge,
          ],
        ),
    );
    expect(settings.organization?.domains.map((entry) => entry.id)).toEqual([
      f.domain.id,
    ]);
    const after = await db.federation().settings(f.scope);
    expect(after.organization?.domains).toHaveLength(2);
  });

  it('domain challenge: a renewed challenge mid-read stays out', async () => {
    const f = await setup();
    const { challenge } = await db
      .federation()
      .domainChallenge({ ...f.scope, domainId: f.domain.id });
    const read = await changeDuringRead(
      'app.auth_domains',
      () =>
        db.federation().domainChallenge({ ...f.scope, domainId: f.domain.id }),
      (query) =>
        query(`update app.auth_domains set challenge=$2 where id=$1`, [
          f.domain.id,
          renewedChallenge,
        ]),
    );
    expect(read.challenge).toBe(challenge);
  });

  it('verification result: a receipt removed mid-read is still the answer', async () => {
    const f = await setup();
    const { challenge } = await db
      .federation()
      .domainChallenge({ ...f.scope, domainId: f.domain.id });
    const command = {
      ...f.scope,
      domainId: f.domain.id,
      expectedRevision: 2,
      idempotencyKey: key(),
    };
    const verified = await db
      .federation()
      .verifyDomain({ ...command, observedChallenge: challenge });
    const read = await changeDuringRead(
      'app.idempotency_records',
      () => db.federation().verificationResult(command),
      (query) =>
        query(`delete from app.idempotency_records where workspace_id=$1`, [
          f.scope.workspaceId,
        ]),
    );
    expect(read).toEqual(verified);
  });
});
