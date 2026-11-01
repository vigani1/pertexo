import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import type { Role } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

import {
  FailureNotificationDestinationError,
  createNotificationDestinationStore,
} from '../../src/testing.js';
import { useIdentityCommandDatabase } from '../identity/command.support.js';

const db = useIdentityCommandDatabase('dest_access');

type Actor = Readonly<{ workspaceId: string; actorId: string }>;

async function setup() {
  const owner = await db.user('Destination owner');
  const workspaceId = await db.workspace(owner.id);
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  await db.asAdmin(
    `with connection_row as (
       insert into app.connections (
         id,workspace_id,provider_key,name,auth_type,status,
         current_secret_version_id,created_by
       ) values ($1,$2,'slack',$4,'slack_bot_token','active',$3,$5)
     )
     insert into app.connection_secret_versions (
       id,workspace_id,connection_id,kms_key_reference,
       encrypted_data_key,ciphertext,nonce,auth_tag,created_by
     ) values ($3,$2,$1,'kms','key','cipher','AAAAAAAAAAAAAAAA',
       'AAAAAAAAAAAAAAAAAAAAAA',$5)`,
    [
      connectionId,
      workspaceId,
      secretVersionId,
      `Alerts ${connectionId}`,
      owner.id,
    ],
  );
  const workflowId = randomUUID();
  await db.asAdmin(
    `insert into app.workflows (id,workspace_id,name,created_by)
     values ($1,$2,'Alerted workflow',$3)`,
    [workflowId, workspaceId, owner.id],
  );
  const connectionString = db.authenticationPool().options.connectionString;
  if (typeof connectionString !== 'string')
    throw new Error('Missing fixture database');
  const store = createNotificationDestinationStore(
    parseDatabaseConfig({ connectionString, max: 2 }),
  );
  const config = (channelId: string) =>
    ({ kind: 'slack', connectionId, channelId }) as const;
  const member = async (role: Role, status = 'active'): Promise<Actor> => {
    const person = await db.user(`Destination ${role}`);
    await db.member(workspaceId, person.id, role);
    if (status !== 'active')
      await db.asAdmin(
        'update app.workspace_memberships set status=$3 where workspace_id=$1 and user_id=$2',
        [workspaceId, person.id, status],
      );
    return { workspaceId, actorId: person.id };
  };
  const ownerActor: Actor = { workspaceId, actorId: owner.id };
  return {
    store,
    config,
    member,
    workflowId,
    workspaceId,
    owner: ownerActor,
    createDestination: async (channelId = 'CFIRST') => {
      const destinationId = randomUUID();
      await store.create({
        ...ownerActor,
        ...once(),
        destinationId,
        config: config(channelId),
      });
      return destinationId;
    },
    setWorkspaceStatus: (status: 'suspended' | 'pending_deletion') =>
      db.asAdmin(
        `update app.workspaces set status=$2::text,
           deletion_requested_at=case when $2::text='pending_deletion' then clock_timestamp() end,
           deletion_requested_by=case when $2::text='pending_deletion' then $3::uuid end,
           deletion_reason=case when $2::text='pending_deletion' then 'destination access proof' end,
           purge_after=case when $2::text='pending_deletion' then clock_timestamp()+interval '1 day' end
         where id=$1`,
        [workspaceId, status, owner.id],
      ),
  };
}

const once = () => ({
  idempotencyKey: randomUUID(),
  requestHash: 'a'.repeat(64),
});

type Fixture = Awaited<ReturnType<typeof setup>>;

function writes(f: Fixture, actor: Actor, destinationId: string) {
  return {
    create: () =>
      f.store.create({
        ...actor,
        ...once(),
        destinationId: randomUUID(),
        config: f.config('CCREATED'),
      }),
    appendVersion: () =>
      f.store.appendVersion({
        ...actor,
        ...once(),
        destinationId,
        expectedVersion: 1,
        config: f.config('CAPPENDED'),
      }),
    setStatus: () =>
      f.store.setStatus({
        ...actor,
        ...once(),
        destinationId,
        status: 'disabled',
      }),
  };
}

function policyWrites(f: Fixture, actor: Actor, destinationId: string) {
  return {
    setWorkflowPolicy: () =>
      f.store.setWorkflowPolicy({
        ...actor,
        ...once(),
        workflowId: f.workflowId,
        destinationId,
      }),
    clearWorkflowPolicy: () =>
      f.store.clearWorkflowPolicy({
        ...actor,
        ...once(),
        workflowId: f.workflowId,
      }),
  };
}

function reads(f: Fixture, actor: Actor, destinationId: string) {
  return {
    get: () => f.store.get({ ...actor, destinationId }),
    list: () => f.store.list(actor),
    getWorkflowPolicy: () =>
      f.store.getWorkflowPolicy({ ...actor, workflowId: f.workflowId }),
  };
}

async function expectNotFound(operation: () => Promise<unknown>) {
  const refused = await operation().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(FailureNotificationDestinationError);
  expect(refused).toMatchObject({ code: 'not_found' });
}

async function withFixture(body: (f: Fixture) => Promise<void>) {
  const f = await setup();
  try {
    await body(f);
  } finally {
    await f.store.close();
  }
}

const storedDestination = async (destinationId: string) =>
  (
    await db.asAdmin<{
      status: string;
      current_config_version: number;
      versions: number;
    }>(
      `select status,current_config_version,
         (select count(*)::int from app.failure_notification_destination_versions v
           where v.destination_id=d.id) versions
       from app.failure_notification_destinations d where id=$1`,
      [destinationId],
    )
  )[0];

const storedDestinationCount = async (workspaceId: string) =>
  (
    await db.asAdmin<{ count: number }>(
      'select count(*)::int from app.failure_notification_destinations where workspace_id=$1',
      [workspaceId],
    )
  )[0]?.count;

const storedPolicy = async (workflowId: string) =>
  (
    await db.asAdmin<{ destination_id: string }>(
      'select destination_id from app.workflow_failure_notification_policies where workflow_id=$1',
      [workflowId],
    )
  )[0]?.destination_id;

describe('failure notification destinations by role', () => {
  it.each(['owner', 'admin'] as const)(
    'lets a %s create, append and set status',
    (role) =>
      withFixture(async (f) => {
        const actor = role === 'owner' ? f.owner : await f.member(role);
        const destinationId = randomUUID();
        await expect(
          f.store.create({
            ...actor,
            ...once(),
            destinationId,
            config: f.config('CFIRST'),
          }),
        ).resolves.toMatchObject({
          status: 'enabled',
          currentVersion: 1,
          config: { channelId: 'CFIRST' },
        });
        await expect(
          f.store.appendVersion({
            ...actor,
            ...once(),
            destinationId,
            expectedVersion: 1,
            config: f.config('CSECOND'),
          }),
        ).resolves.toMatchObject({
          currentVersion: 2,
          config: { channelId: 'CSECOND' },
        });
        await expect(
          f.store.setStatus({
            ...actor,
            ...once(),
            destinationId,
            status: 'disabled',
          }),
        ).resolves.toMatchObject({ status: 'disabled' });
        expect(await storedDestination(destinationId)).toEqual({
          status: 'disabled',
          current_config_version: 2,
          versions: 2,
        });
      }),
  );

  it('refuses a builder creating, appending or setting status as not found, and changes nothing', () =>
    withFixture(async (f) => {
      const builder = await f.member('builder');
      const destinationId = await f.createDestination();

      for (const write of Object.values(writes(f, builder, destinationId)))
        await expectNotFound(write);

      expect(await storedDestination(destinationId)).toEqual({
        status: 'enabled',
        current_config_version: 1,
        versions: 1,
      });
      expect(await storedDestinationCount(f.workspaceId)).toBe(1);
    }));

  it("lets a builder set, read and clear a workflow's policy", () =>
    withFixture(async (f) => {
      const builder = await f.member('builder');
      const destinationId = await f.createDestination();
      const policy = policyWrites(f, builder, destinationId);
      const read = reads(f, builder, destinationId);

      await expect(read.getWorkflowPolicy()).resolves.toBeNull();
      await policy.setWorkflowPolicy();
      expect(await storedPolicy(f.workflowId)).toBe(destinationId);
      await expect(read.getWorkflowPolicy()).resolves.toMatchObject({
        id: destinationId,
      });
      await expect(read.get()).resolves.toMatchObject({ id: destinationId });
      await expect(read.list()).resolves.toMatchObject([{ id: destinationId }]);

      await policy.clearWorkflowPolicy();
      expect(await storedPolicy(f.workflowId)).toBeUndefined();
    }));

  it('refuses a removed member everything as not found', () =>
    withFixture(async (f) => {
      const removed = await f.member('admin', 'removed');
      const destinationId = await f.createDestination();
      await policyWrites(f, f.owner, destinationId).setWorkflowPolicy();

      for (const operation of [
        ...Object.values(writes(f, removed, destinationId)),
        ...Object.values(policyWrites(f, removed, destinationId)),
        ...Object.values(reads(f, removed, destinationId)),
      ])
        await expectNotFound(operation);

      expect(await storedPolicy(f.workflowId)).toBe(destinationId);
      expect(await storedDestination(destinationId)).toMatchObject({
        status: 'enabled',
        versions: 1,
      });
    }));
});

describe('failure notification destinations by workspace state', () => {
  it('keeps reads open while suspended and refuses every write', () =>
    withFixture(async (f) => {
      const destinationId = await f.createDestination();
      await policyWrites(f, f.owner, destinationId).setWorkflowPolicy();
      const builder = await f.member('builder');
      await f.setWorkspaceStatus('suspended');

      const read = reads(f, f.owner, destinationId);
      await expect(read.get()).resolves.toMatchObject({ id: destinationId });
      await expect(read.list()).resolves.toMatchObject([{ id: destinationId }]);
      await expect(read.getWorkflowPolicy()).resolves.toMatchObject({
        id: destinationId,
      });
      await expect(
        reads(f, builder, destinationId).getWorkflowPolicy(),
      ).resolves.toMatchObject({ id: destinationId });

      for (const write of [
        ...Object.values(writes(f, f.owner, destinationId)),
        ...Object.values(policyWrites(f, f.owner, destinationId)),
      ])
        await expectNotFound(write);
      expect(await storedPolicy(f.workflowId)).toBe(destinationId);
    }));

  it('refuses reads and writes once deletion is scheduled', () =>
    withFixture(async (f) => {
      const destinationId = await f.createDestination();
      await policyWrites(f, f.owner, destinationId).setWorkflowPolicy();
      await f.setWorkspaceStatus('pending_deletion');

      for (const operation of [
        ...Object.values(reads(f, f.owner, destinationId)),
        ...Object.values(writes(f, f.owner, destinationId)),
        ...Object.values(policyWrites(f, f.owner, destinationId)),
      ])
        await expectNotFound(operation);
    }));
});
