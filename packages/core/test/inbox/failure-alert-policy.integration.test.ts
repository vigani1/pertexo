import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import type { NoticeMailToSeal } from '../../src/inbox/mail/contract.js';
import { createNotificationDestinationStore } from '../../src/testing.js';
import {
  config,
  inbox,
  mail,
  observer,
  own,
  preferences,
  queryAsOwner,
  seedNoticeWorkspace,
} from './notices.fixture.js';

type Scope = Readonly<{ workspaceId: string; actorId: string }>;

// One of each, because every fixture call opens its own pool.
let reader: ReturnType<typeof inbox>;
let scanner: ReturnType<typeof observer>;
beforeAll(() => {
  reader = inbox();
  scanner = observer();
});

/** The observer walks every workspace a page at a time, so give it enough turns. */
async function observeUntil(done: () => Promise<boolean>) {
  for (let scan = 0; scan < 40 && !(await done()); scan += 1)
    await scanner.observeCurrent?.();
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

describe('a policy that points at a destination that can no longer send', () => {
  async function strandedDestination() {
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
        `Alert ${connectionId}`,
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
      config: { kind: 'email', connectionId, toEmail: 'alerts@example.test' },
    });
    await destinations.setWorkflowPolicy({
      ...command(),
      workflowId: f.workflowId,
      destinationId,
    });
    const setStatus = (status: 'enabled' | 'disabled') =>
      destinations.setStatus({ ...command(), destinationId, status });
    await setStatus('disabled');
    await observeUntil(
      async () => (await noticeFor(f.scope, destinationId)) !== undefined,
    );
    return { ...f, destinationId, setStatus };
  }

  it('tells owners and admins only', async () => {
    const f = await strandedDestination();
    const as = (actor: string) =>
      noticeFor(
        { workspaceId: f.workspaceId, actorId: actor },
        f.destinationId,
      );

    expect(await as(f.members.owner)).toMatchObject({ name: 'email' });
    expect(await as(f.members.admin)).toMatchObject({ name: 'email' });
    expect(await as(f.members.operator)).toBeUndefined();
    expect(await as(f.members.builder)).toBeUndefined();
    expect(await as(f.members.viewer)).toBeUndefined();
  });

  it('clears when the destination is turned back on', async () => {
    const f = await strandedDestination();

    await f.setStatus('enabled');
    await observeUntil(
      async () => (await noticeFor(f.scope, f.destinationId)) === undefined,
    );

    expect(await noticeFor(f.scope, f.destinationId)).toBeUndefined();
  });

  it('goes into notice mail while it holds, under its plain name', async () => {
    const f = await strandedDestination();
    await preferences().replace({
      ...f.scope,
      mode: 'immediate',
      hour: 9,
      timeZone: 'UTC',
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    // Mail only carries what happened after the person chose it.
    await f.setStatus('enabled');
    await observeUntil(
      async () => (await noticeFor(f.scope, f.destinationId)) === undefined,
    );
    await f.setStatus('disabled');
    await observeUntil(
      async () => (await noticeFor(f.scope, f.destinationId)) !== undefined,
    );
    const captured: NoticeMailToSeal[] = [];
    const sender = mail(captured);
    const mine = () =>
      captured.filter(({ workspaceId }) => workspaceId === f.workspaceId);
    for (let cycle = 0; cycle < 40 && mine().length === 0; cycle += 1)
      await sender.prepare();
    expect(mine().flatMap(({ items }) => items)).toMatchObject([
      {
        noticeKind: 'failure_alert_attention',
        name: 'email',
        subjectId: f.destinationId,
      },
    ]);
  });
});
