import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  Pool,
  adminUrl,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  pgCode,
  randomUUID,
  workspaceA,
} from '../support/connections.js';
import { ConnectionSharingRevisionConflictError } from '../../src/connections/contract.js';
import {
  asDatabaseOwner,
  connections,
  setWorkspaceStatusStatement,
} from './member-access/world.js';

async function created() {
  const input = createInput();
  await connections.api.createConnection(input);
  return input;
}

/** A second transaction that holds what it took until the test lets go. */
async function holding<T>(
  take: (client: PoolClient) => Promise<unknown>,
  work: (
    release: (end: 'commit' | 'rollback') => Promise<void>,
    client: PoolClient,
  ) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString: databaseUrl(migrationBaseUrl),
    max: 1,
  });
  const client = await pool.connect();
  let open = true;
  const release = async (end: 'commit' | 'rollback') => {
    if (!open) return;
    open = false;
    await client.query(end);
  };
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    await take(client);
    return await work(release, client);
  } finally {
    await release('rollback').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

/** Waits until a query in this database, naming `matching`, is stuck on a lock. */
async function untilSomethingWaits(matching: string): Promise<void> {
  const observer = new Pool({
    connectionString: databaseUrl(adminUrl),
    max: 1,
  });
  try {
    await expect
      .poll(
        async () => {
          const { rows } = await observer.query<{ waiting: boolean }>(
            `select exists(
               select 1 from pg_stat_activity
               where datname=current_database() and wait_event_type='Lock'
                 and query ilike $1
             ) waiting`,
            [`%${matching}%`],
          );
          return rows[0]?.waiting;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    await observer.end();
  }
}

const lockEntitlements = (client: PoolClient) =>
  client
    .query(
      `select 1 from app.workspace_execution_entitlements current
       join app.workspace_execution_entitlement_versions version
         on version.workspace_id=current.workspace_id
        and version.version=current.current_version
       where current.workspace_id=$1
       for update of current, version`,
      [workspaceA],
    )
    .then(({ rowCount }) => {
      expect(rowCount).toBe(1);
    });

const NOT_ANSWERED = Symbol('not answered');

/** Whether an attempt finishes on its own, while something else is held. */
function answersWithin<T>(attempt: Promise<T>, milliseconds: number) {
  return Promise.race([
    attempt,
    new Promise<typeof NOT_ANSWERED>((resolve) => {
      setTimeout(() => {
        resolve(NOT_ANSWERED);
      }, milliseconds);
    }),
  ]);
}

describe('an entitlement change in progress', () => {
  it('doesn’t hold up a member’s connection commands', async () => {
    const existing = await created();
    const fresh = createInput();
    const dispatchToken = randomUUID();
    await holding(lockEntitlements, async () => {
      await expect(
        answersWithin(connections.api.createConnection(fresh), 5_000),
      ).resolves.toMatchObject({ id: fresh.connectionId });
      await expect(
        answersWithin(
          connections.api.listConnections({
            workspaceId: workspaceA,
            actorId: ownerA,
            limit: 1,
          }),
          5_000,
        ),
      ).resolves.toMatchObject({ items: [{ id: fresh.connectionId }] });
      await expect(
        answersWithin(
          connections.api.startConnectionTest({
            workspaceId: workspaceA,
            actorId: ownerA,
            connectionId: existing.connectionId,
            expectedProviderKey: 'http',
            idempotencyKey: `entitlement-${randomUUID()}`,
            requestHash: 'a'.repeat(64),
            dispatchToken,
          }),
          5_000,
        ),
      ).resolves.toEqual({ kind: 'dispatch', dispatchToken });
      await expect(
        answersWithin(
          connections.api.revokeConnection({
            workspaceId: workspaceA,
            actorId: ownerA,
            connectionId: existing.connectionId,
          }),
          5_000,
        ),
      ).resolves.toMatchObject({ status: 'revoked' });
    });
  });

  it('still holds up a worker using a credential, which has no member', async () => {
    const existing = await created();
    await holding(lockEntitlements, async (release) => {
      const resolving = connections.worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: existing.connectionId,
        expectedProviderKey: 'http',
        workerId: 'worker-entitlement-test',
        purpose: 'test',
      });
      await expect(answersWithin(resolving, 300)).resolves.toBe(NOT_ANSWERED);
      await release('rollback');
      await expect(resolving).resolves.toMatchObject({
        secretVersionId: existing.secretVersionId,
      });
    });
  });
});

describe('a workspace deletion and a member’s command', () => {
  it('a command that arrives during the request is refused when it commits', async () => {
    const fresh = createInput();
    await holding(
      (client) => setWorkspaceStatusStatement(client, 'pending_deletion'),
      async (release) => {
        const creating = connections.api.createConnection(fresh);
        void creating.catch(() => undefined);
        await expect(answersWithin(creating, 300)).resolves.toBe(NOT_ANSWERED);
        await release('commit');
        await expect(creating).rejects.toBeInstanceOf(ConnectionNotFoundError);
      },
    );
    await asDatabaseOwner(workspaceA, (client) =>
      setWorkspaceStatusStatement(client, 'active'),
    );
    expect(
      await connections.api.getConnection(workspaceA, fresh.connectionId),
    ).toBeNull();
  });

  it('the request waits for a command already holding the workspace', async () => {
    const existing = await created();
    // The audit insert is the command's last step, so it stops there holding its locks.
    await holding(
      (client) =>
        client.query('lock table app.audit_events in access exclusive mode'),
      async (releaseAudit) => {
        const revoking = connections.api.revokeConnection({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: existing.connectionId,
        });
        void revoking.catch(() => undefined);
        await untilSomethingWaits('audit_events');

        await holding(
          () => Promise.resolve(),
          async (releaseRequest, client) => {
            const requesting = setWorkspaceStatusStatement(
              client,
              'pending_deletion',
            );
            await expect(answersWithin(requesting, 300)).resolves.toBe(
              NOT_ANSWERED,
            );
            await releaseAudit('rollback');
            await expect(revoking).resolves.toMatchObject({
              status: 'revoked',
            });
            await expect(requesting).resolves.toMatchObject({ rowCount: 1 });
            await releaseRequest('rollback');
          },
        );
      },
    );
  }, 20_000);
});

describe('sharing changes at the same moment', () => {
  const replace = (
    connectionId: string,
    expectedSharingRevision: number,
    idempotencyKey: string = randomUUID(),
    mode: 'workspace' | 'restricted' = 'restricted',
  ) =>
    connections.api.replaceConnectionSharing({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId,
      idempotencyKey,
      request: { mode, userIds: [], expectedSharingRevision },
    });

  const currentRevision = async (connectionId: string) =>
    (
      await connections.api.readConnectionSharing({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId,
      })
    ).revision;

  it('lets one win, and the rest get a revision conflict rather than a deadlock', async () => {
    const { connectionId } = await created();
    const revision = await currentRevision(connectionId);
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => replace(connectionId, revision)),
    );
    const failures = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    expect(failures.filter(pgCode('40P01'))).toEqual([]);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(failures).toHaveLength(3);
    for (const failure of failures)
      expect(failure).toBeInstanceOf(ConnectionSharingRevisionConflictError);
    expect(await currentRevision(connectionId)).toBe(revision + 1);
  });

  it('lets changes to different connections all land', async () => {
    const inputs = await Promise.all([created(), created(), created()]);
    const revisions = await Promise.all(
      inputs.map(({ connectionId }) => currentRevision(connectionId)),
    );
    await expect(
      Promise.all(
        inputs.map(({ connectionId }, index) =>
          replace(connectionId, revisions[index] ?? 0),
        ),
      ),
    ).resolves.toHaveLength(3);
  });

  it('gives an exact retry at the same moment the first answer', async () => {
    const { connectionId } = await created();
    const revision = await currentRevision(connectionId);
    const key = randomUUID();
    const [first, second] = await Promise.all([
      replace(connectionId, revision, key),
      replace(connectionId, revision, key),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.revision).toBe(revision + 1);
    expect(second.revision).toBe(revision + 1);
  });

  it('refuses the same key with a different request', async () => {
    const { connectionId } = await created();
    const revision = await currentRevision(connectionId);
    const key = randomUUID();
    await replace(connectionId, revision, key);
    await expect(
      replace(connectionId, revision + 1, key, 'workspace'),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);
  });
});

describe('a retry of a command answered before sharing existed', () => {
  it('reads back as a workspace-wide connection', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    await asDatabaseOwner(workspaceA, (client) =>
      client.query(
        `update app.idempotency_records
         set result_ref=(result_ref #- '{connection,accessMode}') #- '{accessMode}'
         where workspace_id=$1 and operation='connection.create' and resource_id=$2`,
        [workspaceA, input.connectionId],
      ),
    );
    const { rows } = await asDatabaseOwner(workspaceA, (client) =>
      client.query<{ stored: string }>(
        `select result_ref::text as stored from app.idempotency_records
         where workspace_id=$1 and resource_id=$2`,
        [workspaceA, input.connectionId],
      ),
    );
    expect(rows.map(({ stored }) => stored).join()).not.toContain('accessMode');

    await expect(
      connections.api.findConnectionCreateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      }),
    ).resolves.toMatchObject({
      id: input.connectionId,
      accessMode: 'workspace',
    });
  });
});
