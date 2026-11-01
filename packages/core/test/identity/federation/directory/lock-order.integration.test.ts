import { createHash, randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFederationManagementStore } from '../../../../src/identity/index.js';
import { createDirectoryCredential } from '../../../../src/identity/federation/provisioning/management/credentials.repository.js';
import { authenticateDirectory } from '../../../../src/identity/federation/provisioning/authority.repository.js';
import { replaceDirectoryMappings } from '../../../../src/identity/federation/provisioning/management/mappings.repository.js';
import { createDirectoryUser } from '../../../../src/identity/federation/provisioning/resources/users.repository.js';
import { createDirectoryStore } from '../../../../src/identity/federation/provisioning/store.js';
import { useIdentityCommandDatabase } from '../../command.support.js';

const db = useIdentityCommandDatabase('directory_locks');

const DEADLOCK = '40P01';
const peopleQuery = { limit: 20 };

let databaseUrl: string;
let holderPool: Pool;
let readers: ReturnType<typeof createDirectoryStore>;
let federation: ReturnType<typeof createFederationManagementStore>;
let writers: Pool;

beforeAll(async () => {
  const [row] = await db.asAdmin<{ name: string }>(
    'select current_database() as name',
  );
  const url = new URL(
    process.env.DATABASE_URL ??
      'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
  );
  url.pathname = `/${String(row?.name)}`;
  databaseUrl = url.toString();
  const config = parseDatabaseConfig({ connectionString: databaseUrl, max: 8 });
  readers = createDirectoryStore(config);
  federation = createFederationManagementStore(
    parseDatabaseConfig({ connectionString: databaseUrl, max: 7 }),
  );
  holderPool = new Pool({ connectionString: databaseUrl, max: 1 });
  writers = new Pool({ connectionString: databaseUrl, max: 8 });
});

afterAll(async () => {
  await Promise.all([
    readers.close(),
    federation.close(),
    holderPool.end(),
    writers.end(),
  ]);
});

/** An organization with a control workspace, a linked one and a shared owner. */
async function organizationWithLinkedWorkspace() {
  const owner = await db.user('Directory owner'),
    control = await db.workspace(owner.id),
    linked = await db.workspace(owner.id);
  const scope = { workspaceId: control, actorId: owner.id };
  const settings = await federation.createOrganization({
    ...scope,
    name: `Locks ${randomUUID().slice(0, 8)}`,
    idempotencyKey: randomUUID(),
  });
  if (settings.organization === null) throw new Error('Missing organization');
  await federation.linkWorkspace({
    ...scope,
    targetWorkspaceId: linked,
    defaultRole: 'viewer',
    expectedRevision: settings.organization.revision,
    idempotencyKey: randomUUID(),
  });
  return {
    owner,
    control,
    linked,
    scope,
    organizationId: settings.organization.id,
  };
}

type Organization = Awaited<ReturnType<typeof organizationWithLinkedWorkspace>>;

async function revisionOf(organizationId: string): Promise<number> {
  const [row] = await db.asAdmin<{ revision: number }>(
    'select revision from app.auth_organizations where id=$1',
    [organizationId],
  );
  return Number(row?.revision);
}

const addDomain = async (f: Organization) =>
  federation.createDomain({
    ...f.scope,
    domain: `${randomUUID().slice(0, 8)}.example.test`,
    expectedRevision: await revisionOf(f.organizationId),
    idempotencyKey: randomUUID(),
  });

async function blockedBackends(): Promise<number> {
  const [row] = await db.asAdmin<{ count: number }>(
    `select count(*)::int as count from pg_stat_activity
     where datname=current_database() and wait_event_type='Lock'`,
  );
  return Number(row?.count);
}

const blockedReaches = (count: number) =>
  expect.poll(blockedBackends, { timeout: 10_000, interval: 25 }).toBe(count);

function deadlocked(results: readonly PromiseSettledResult<unknown>[]) {
  return results.filter((result) => {
    let current: unknown = result.status === 'rejected' ? result.reason : null;
    while (typeof current === 'object' && current !== null) {
      if ('code' in current && current.code === DEADLOCK) return true;
      current = 'cause' in current ? current.cause : null;
    }
    return false;
  });
}

/** Holds the organization row, so the next arrivals queue in a known order. */
async function holdingOrganization<T>(
  organizationId: string,
  work: () => Promise<T>,
): Promise<T> {
  const holder = await holderPool.connect();
  try {
    await holder.query('begin');
    await holder.query(
      'select id from app.auth_organizations where id=$1 for update',
      [organizationId],
    );
    return await work();
  } finally {
    await holder.query('rollback');
    holder.release();
  }
}

describe('directory reads against writers that lock the organization', () => {
  it.each(['settings', 'people'] as const)(
    'a federation command that reaches the organization first does not deadlock with %s read from a linked workspace by a shared member',
    async (kind) => {
      const f = await organizationWithLinkedWorkspace();
      const scope = { workspaceId: f.linked, actorId: f.owner.id };
      const read = () =>
        kind === 'settings'
          ? readers.settings(scope)
          : readers.people(scope, peopleQuery);

      const results = await holdingOrganization(f.organizationId, async () => {
        const command = addDomain(f);
        await blockedReaches(1);
        const reading = read();
        // Blocked behind the command, or finished if the read takes no locks.
        await Promise.race([reading.catch(() => undefined), blockedReaches(2)]);
        return () => Promise.allSettled([command, reading]);
      });

      const settled = await results();
      expect(deadlocked(settled)).toEqual([]);
      expect(settled.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
    },
    30_000,
  );

  it('a burst of reads and every kind of writer, across linked workspaces, never deadlocks', async () => {
    const f = await organizationWithLinkedWorkspace();
    const issued = await createDirectoryCredential(writers, {
      ...f.scope,
      name: 'Burst client',
      expectedRevision: await revisionOf(f.organizationId),
      idempotencyKey: randomUUID(),
    });
    if (issued.replayed) throw new Error('Fresh credential replayed');
    const principal = await authenticateDirectory(
      writers,
      f.organizationId,
      createHash('sha256').update(issued.secret).digest('hex'),
    );
    const person = () => {
      const email = `${randomUUID()}@example.test`;
      return {
        userName: email,
        active: true,
        externalId: null,
        profile: { emails: [{ value: email, primary: true }] },
      };
    };
    const results: PromiseSettledResult<unknown>[] = [];
    for (let round = 0; round < 8; round++) {
      results.push(
        ...(await Promise.allSettled([
          readers.settings({ workspaceId: f.linked, actorId: f.owner.id }),
          readers.people(
            { workspaceId: f.control, actorId: f.owner.id },
            peopleQuery,
          ),
          readers.settings({ workspaceId: f.control, actorId: f.owner.id }),
          readers.people(
            { workspaceId: f.linked, actorId: f.owner.id },
            peopleQuery,
          ),
          addDomain(f),
          createDirectoryUser(writers, principal, person()),
          revisionOf(f.organizationId).then((expectedRevision) =>
            replaceDirectoryMappings(writers, {
              ...f.scope,
              mappings: [],
              expectedRevision,
              idempotencyKey: randomUUID(),
            }),
          ),
        ])),
      );
    }
    expect(deadlocked(results)).toEqual([]);
  }, 60_000);
});
