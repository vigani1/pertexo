import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import type { NoticeMailToSeal } from '../../../src/inbox/mail/contract.js';
import { createNotificationDestinationStore } from '../../../src/testing.js';
import {
  config,
  inbox,
  mail,
  observer,
  own,
  preferences,
  queryAsOwner,
  seedNoticeWorkspace,
} from '../notices.fixture.js';

type Scope = Readonly<{ workspaceId: string; actorId: string }>;

const ALERT_ADDRESS = 'private-alerts@example.test';
const CONNECTION_NAME = 'Someone wrote this connection name';

let reader: ReturnType<typeof inbox>;
let scanner: ReturnType<typeof observer>;
beforeAll(() => {
  reader = inbox();
  scanner = observer();
});

async function scan(walks = 3) {
  for (let walk = 0; walk < walks; walk += 1) await scanner.observeCurrent?.();
}

async function noticeFor(scope: Scope, destinationId: string) {
  const { items } = await reader.listThreads({
    ...scope,
    filter: 'all',
    noticeKind: 'failure_alert_attention',
    limit: 100,
  });
  return items.find(
    (item) => 'subjectId' in item && item.subjectId === destinationId,
  );
}

/** A workspace whose workflow alerts through a working destination. */
async function healthyPolicy() {
  const f = await seedNoticeWorkspace();
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  await queryAsOwner(
    `with connection_row as (
       insert into app.connections (
         id,workspace_id,provider_key,name,auth_type,status,
         current_secret_version_id,created_by
       ) values ($1,$2,'email',$3,'resend_api_key','active',$4,$5)
     )
     insert into app.connection_secret_versions (
       id,workspace_id,connection_id,kms_key_reference,
       encrypted_data_key,ciphertext,nonce,auth_tag,created_by
     ) values ($4,$2,$1,'kms','key','cipher','AAAAAAAAAAAAAAAA',
       'AAAAAAAAAAAAAAAAAAAAAA',$5)`,
    [
      connectionId,
      f.workspaceId,
      CONNECTION_NAME,
      secretVersionId,
      f.members.owner,
    ],
    f.workspaceId,
  );
  const destinations = own(createNotificationDestinationStore(config()));
  const command = () => ({
    ...f.scope,
    idempotencyKey: randomUUID(),
    requestHash: 'a'.repeat(64),
  });
  const destinationId = randomUUID();
  await destinations.create({
    ...command(),
    destinationId,
    config: { kind: 'email', connectionId, toEmail: ALERT_ADDRESS },
  });
  await destinations.setWorkflowPolicy({
    ...command(),
    workflowId: f.workflowId,
    destinationId,
  });
  const setConnection = (assignment: string) =>
    queryAsOwner(
      `update app.connections set ${assignment} where workspace_id=$1 and id=$2`,
      [f.workspaceId, connectionId],
      f.workspaceId,
    );
  return {
    ...f,
    connectionId,
    destinationId,
    destinations,
    command,
    setConnection,
  };
}

type Policy = Awaited<ReturnType<typeof healthyPolicy>>;

describe('what a policy can point at', () => {
  it('raises nothing while the destination can send', async () => {
    const f = await healthyPolicy();

    await scan();

    expect(await noticeFor(f.scope, f.destinationId)).toBeUndefined();
  });

  it.each<[string, (f: Policy) => Promise<unknown>]>([
    [
      'its connection needs reauthorizing',
      (f) => f.setConnection("status='reauthorization_required'"),
    ],
    ['its connection is revoked', (f) => f.setConnection("status='revoked'")],
  ])('raises a notice when %s', async (_cause, breakIt) => {
    const f = await healthyPolicy();

    await breakIt(f);
    await scan();

    expect(await noticeFor(f.scope, f.destinationId)).toMatchObject({
      noticeKind: 'failure_alert_attention',
      name: 'email',
      workflowId: null,
      unread: true,
    });
  });

  it('clears when the connection works again, and comes back unread when it breaks again', async () => {
    const f = await healthyPolicy();
    await f.setConnection("status='reauthorization_required'");
    await scan();
    const raised = await noticeFor(f.scope, f.destinationId);
    if (raised === undefined) throw new Error('Expected the notice');
    await reader.markThreadRead({
      ...f.scope,
      threadId: raised.id,
      revision: raised.revision,
    });

    await f.setConnection("status='active'");
    await scan();
    expect(await noticeFor(f.scope, f.destinationId)).toBeUndefined();

    await f.setConnection("status='revoked'");
    await scan();
    expect(await noticeFor(f.scope, f.destinationId)).toMatchObject({
      id: raised.id,
      unread: true,
      occurrenceCount: 2,
    });
  });

  it('leaves a read notice read while its cause merely stays', async () => {
    const f = await healthyPolicy();
    await f.setConnection("status='revoked'");
    await scan();
    const raised = await noticeFor(f.scope, f.destinationId);
    if (raised === undefined) throw new Error('Expected the notice');
    await reader.markThreadRead({
      ...f.scope,
      threadId: raised.id,
      revision: raised.revision,
    });

    await scan(5);
    expect(await noticeFor(f.scope, f.destinationId)).toEqual({
      ...raised,
      unread: false,
    });
  });

  it('clears when the only policy goes', async () => {
    const f = await healthyPolicy();
    await f.setConnection("status='revoked'");
    await scan();
    expect(await noticeFor(f.scope, f.destinationId)).toBeDefined();

    await f.destinations.clearWorkflowPolicy({
      ...f.command(),
      workflowId: f.workflowId,
    });
    await scan();

    expect(await noticeFor(f.scope, f.destinationId)).toBeUndefined();
  });

  it('clears when the destination no longer exists', async () => {
    const f = await healthyPolicy();
    await f.setConnection("status='revoked'");
    await scan();
    expect(await noticeFor(f.scope, f.destinationId)).toBeDefined();

    await queryAsOwner(
      `with policy as (
         delete from app.workflow_failure_notification_policies
          where workspace_id=$1 and destination_id=$2
       ), version as (
         delete from app.failure_notification_destination_versions
          where workspace_id=$1 and destination_id=$2
       )
       delete from app.failure_notification_destinations
        where workspace_id=$1 and id=$2`,
      [f.workspaceId, f.destinationId],
      f.workspaceId,
    );
    await scan();

    expect(await noticeFor(f.scope, f.destinationId)).toBeUndefined();
  });
});

describe('who it reaches', () => {
  async function standing() {
    const f = await healthyPolicy();
    await f.setConnection("status='revoked'");
    await scan();
    const notice = await noticeFor(f.scope, f.destinationId);
    if (notice === undefined) throw new Error('Expected the notice');
    return { ...f, notice };
  }

  it('counts for an owner and an admin, and for nobody else', async () => {
    const f = await standing();

    for (const actorId of [f.members.owner, f.members.admin])
      expect(
        await reader.readSummary({ workspaceId: f.workspaceId, actorId }),
      ).toEqual({ unreadCount: 1, revision: f.notice.revision });
    for (const actorId of [
      f.members.builder,
      f.members.operator,
      f.members.viewer,
    ]) {
      const scope = { workspaceId: f.workspaceId, actorId };
      expect((await reader.readSummary(scope)).unreadCount).toBe(0);
      expect(
        await reader.listThreads({ ...scope, filter: 'all', limit: 100 }),
      ).toMatchObject({ items: [] });
      expect(
        await reader.markThreadRead({
          ...scope,
          threadId: f.notice.id,
          revision: f.notice.revision,
        }),
      ).toBeUndefined();
    }
  });

  it('shows nothing to a member of another workspace, there or in their own', async () => {
    const f = await standing();
    const other = await seedNoticeWorkspace();
    const outsider = {
      workspaceId: f.workspaceId,
      actorId: other.members.owner,
    };

    expect(
      await reader.listThreads({ ...outsider, filter: 'all', limit: 100 }),
    ).toEqual({ items: [], next: null, revision: '0' });
    expect(await reader.readSummary(outsider)).toEqual({
      unreadCount: 0,
      revision: '0',
    });
    expect(await noticeFor(other.scope, f.destinationId)).toBeUndefined();
  });

  it('mails an owner and an admin only, in words nobody typed', async () => {
    const f = await healthyPolicy();
    const everyone = Object.values(f.members);
    const store = preferences();
    for (const actorId of everyone)
      await store.replace({
        workspaceId: f.workspaceId,
        actorId,
        mode: 'immediate',
        hour: 9,
        timeZone: 'UTC',
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
    await f.setConnection("status='revoked'");
    await scan();
    const captured: NoticeMailToSeal[] = [];
    const sender = mail(captured);
    const mine = () =>
      captured.filter(({ workspaceId }) => workspaceId === f.workspaceId);
    for (let cycle = 0; cycle < 40 && mine().length < 2; cycle += 1)
      await sender.prepare();
    for (let cycle = 0; cycle < 5; cycle += 1) await sender.prepare();

    expect(
      mine()
        .map(({ actorId }) => actorId)
        .sort(),
    ).toEqual([f.members.owner, f.members.admin].sort());
    const written = JSON.stringify(mine());
    expect(written).not.toContain(ALERT_ADDRESS);
    expect(written).not.toContain(CONNECTION_NAME);
    expect(written).not.toMatch(/dead.?letter|intent/iu);
    expect(mine().flatMap(({ items }) => items)).toMatchObject([
      { noticeKind: 'failure_alert_attention', name: 'email' },
      { noticeKind: 'failure_alert_attention', name: 'email' },
    ]);
  });

  it('cancels mail about a notice that cleared before it was sent', async () => {
    const f = await healthyPolicy();
    await preferences().replace({
      ...f.scope,
      mode: 'immediate',
      hour: 9,
      timeZone: 'UTC',
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await f.setConnection("status='revoked'");
    await scan();
    const captured: NoticeMailToSeal[] = [];
    const sender = mail(captured);
    const mine = () =>
      captured.find(({ workspaceId }) => workspaceId === f.workspaceId);
    for (let cycle = 0; cycle < 40 && mine() === undefined; cycle += 1)
      await sender.prepare();
    const sealed = mine();
    if (sealed === undefined) throw new Error('Expected prepared mail');
    expect(await sender.authorize(sealed.id)).toBe(true);

    await f.setConnection("status='active'");
    await scan();

    expect(await sender.authorize(sealed.id)).toBe(false);
  });
});
