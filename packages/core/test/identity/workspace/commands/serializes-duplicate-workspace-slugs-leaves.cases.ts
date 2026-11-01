import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { expect, it } from 'vitest';
import {
  IdentityConflictError,
  IdempotencyRequestConflictError,
} from '../../../../src/testing.js';
import { auditEvents, workspaceMemberships } from '@pertexo/database/testing';

import {
  adminDatabaseUrl,
  apiUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
} from '../fixture.js';

export function registerSerializesDuplicateWorkspaceSlugsLeaves(): void {
  it('serializes duplicate workspace slugs and leaves one complete aggregate', async () => {
    const slug = `concurrent-${randomUUID().slice(0, 12)}`;
    const outcomes = await Promise.allSettled([
      identityDatabase.createWorkspaceWithOwner({
        name: 'Concurrent A',
        slug,
        ownerUserId,
      }),
      identityDatabase.createWorkspaceWithOwner({
        name: 'Concurrent B',
        slug,
        ownerUserId,
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toBeDefined();
    if (rejected?.status !== 'rejected') {
      throw new Error('Expected one workspace slug conflict');
    }
    expect(rejected.reason).toBeInstanceOf(IdentityConflictError);
    expect(rejected.reason).toMatchObject({ reason: 'workspace_slug' });
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const result = await pool.query<{ id: string }>(
        `select w.id from app.workspaces w where w.slug = $1`,
        [slug],
      );
      expect(result.rows).toHaveLength(1);
      const aggregateId = result.rows[0]?.id;
      if (aggregateId === undefined)
        throw new Error('Concurrent workspace was not returned');
      const aggregate = await tenantDatabase.withWorkspace(
        aggregateId,
        async ({ db }) => ({
          members: await db.select().from(workspaceMemberships),
          events: await db.select().from(auditEvents),
        }),
      );
      expect(aggregate.members).toHaveLength(1);
      expect(aggregate.events.map((event) => event.action).sort()).toEqual([
        'workspace.created',
        'workspace.member_added',
      ]);
    } finally {
      await pool.end();
    }
  });

  it('returns one durable workspace creation for concurrent exact idempotency retries and conflicts on changed input', async () => {
    const slug = 'idempotent-hash-golden';
    const idempotencyKey = `create-${randomUUID()}`;
    const command = {
      name: 'Idempotent workspace',
      slug,
      ownerUserId,
      idempotencyKey,
    } as const;

    const [left, right] = await Promise.all([
      identityDatabase.createWorkspaceWithOwner(command),
      identityDatabase.createWorkspaceWithOwner(command),
    ]);

    expect(right).toEqual(left);
    await expect(
      identityDatabase.createWorkspaceWithOwner({
        ...command,
        name: 'Changed workspace request',
      }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    const aggregate = await tenantDatabase.withWorkspace(
      left.id,
      async ({ db }) => ({
        memberships: await db.select().from(workspaceMemberships),
        events: await db.select().from(auditEvents),
      }),
    );
    expect(aggregate.memberships).toHaveLength(1);
    expect(aggregate.events.map((event) => event.action).sort()).toEqual([
      'workspace.created',
      'workspace.member_added',
    ]);
    const inspection = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      const receipt = await inspection.query<{ request_hash: string }>(
        `select request_hash from app.workspace_creation_idempotency_records
          where actor_user_id=$1 and key_hash=$2`,
        [
          ownerUserId,
          createHash('sha256').update(idempotencyKey).digest('hex'),
        ],
      );
      const historicalBytes = `{"actorId":"${ownerUserId}","metadata":{},"name":"Idempotent workspace","requestedWorkspaceId":null,"slug":"${slug}"}`;
      const golden =
        'e26263bff6894ce437a96dc2757c41515f9fc389c480b65757a8b164079d4482';
      expect(createHash('sha256').update(historicalBytes).digest('hex')).toBe(
        golden,
      );
      expect(receipt.rows).toEqual([{ request_hash: golden }]);
    } finally {
      await inspection.end();
    }
  });

  it('uses shared canonical bytes for nested workspace metadata and reordered retries', async () => {
    const idempotencyKey = `canonical-${randomUUID()}`;
    const command = {
      name: 'Canonical metadata',
      slug: 'canonical-metadata',
      ownerUserId,
      idempotencyKey,
      metadata: {
        '10': 'ten',
        '2': 'two',
        Z: 'upper',
        a: 'lower',
        nested: { é: 'accent', A: 'first' },
      },
    } as const;
    const created = await identityDatabase.createWorkspaceWithOwner(command);
    expect(
      await identityDatabase.createWorkspaceWithOwner({
        ...command,
        metadata: {
          nested: { A: 'first', é: 'accent' },
          a: 'lower',
          Z: 'upper',
          '2': 'two',
          '10': 'ten',
        },
      }),
    ).toEqual(created);
    const inspection = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      const receipt = await inspection.query<{ request_hash: string }>(
        `select request_hash from app.workspace_creation_idempotency_records
          where actor_user_id=$1 and key_hash=$2`,
        [
          ownerUserId,
          createHash('sha256').update(idempotencyKey).digest('hex'),
        ],
      );
      const bytes = `{"actorId":"${ownerUserId}","metadata":{"2":"two","10":"ten","Z":"upper","a":"lower","nested":{"A":"first","é":"accent"}},"name":"Canonical metadata","requestedWorkspaceId":null,"slug":"canonical-metadata"}`;
      const golden =
        'f0e4a1c182264ccc19108cacff7090a2dd3e745f6ddc4a0a6b816eae9668a20c';
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(golden);
      expect(receipt.rows).toEqual([{ request_hash: golden }]);
    } finally {
      await inspection.end();
    }
  });

  it('keeps one user per email', async () => {
    const email = `${randomUUID()}@example.test`;
    await identityDatabase.createUser({ email, displayName: 'Profile A' });
    await expect(
      identityDatabase.createUser({ email, displayName: 'Profile B' }),
    ).rejects.toBeInstanceOf(IdentityConflictError);
  });
}
