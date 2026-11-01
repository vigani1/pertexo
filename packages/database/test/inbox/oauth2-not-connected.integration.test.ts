import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { createConnectionDatabase } from '../../src/connections/repository.js';
import type { NoticeMailToSeal } from '../../src/inbox/mail/contract.js';
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

const NOT_CONNECTED = 'connection.oauth2_not_authorized';
const GRANT_LOST = 'connection.oauth2_grant_revoked';

/** Made the way the API makes one: nobody has signed in yet. */
async function newOAuth2Connection(workspaceId: string, owner: string) {
  const connectionId = randomUUID();
  await own(createConnectionDatabase(config())).createConnection({
    workspaceId,
    actorId: owner,
    connectionId,
    secretVersionId: randomUUID(),
    providerKey: 'http',
    name: 'New service',
    authType: 'oauth2',
    oauth2Settings: {
      grantType: 'client_credentials',
      tokenUrl: 'https://id.example.com/token',
      clientId: 'client',
      scope: '',
      clientAuthentication: 'basic',
      tokenParameters: {},
      requestHosts: { mode: 'any' },
    },
    idempotencyKey: randomUUID(),
    requestHash: 'a'.repeat(64),
    sealed: {
      kmsKeyReference: 'self-managed:v1',
      encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
      ciphertext: 'ZW5jcnlwdGVk',
      nonce: Buffer.alloc(12, 1).toString('base64url'),
      tag: Buffer.alloc(16, 1).toString('base64url'),
    },
  });
  return connectionId;
}

const setErrorCode = (
  workspaceId: string,
  connectionId: string,
  code: string,
) =>
  queryAsOwner(
    'update app.connections set last_error_code=$2 where id=$1',
    [connectionId, code],
    workspaceId,
  );

// M4: a brand-new connection isn't broken; nothing uses it and nobody has connected it.
it('M4 a connection nobody has connected opens no notice', async () => {
  const f = await seedNoticeWorkspace();
  await newOAuth2Connection(f.workspaceId, f.members.owner);
  await observer().observeCurrent?.();
  const { items } = await inbox().listThreads({
    ...f.scope,
    filter: 'all',
    limit: 100,
  });
  expect(items).toEqual([]);
});

it('a connection that lost its grant does open a notice', async () => {
  const f = await seedNoticeWorkspace();
  const id = await newOAuth2Connection(f.workspaceId, f.members.owner);
  await setErrorCode(f.workspaceId, id, GRANT_LOST);
  await observer().observeCurrent?.();
  const { items } = await inbox().listThreads({
    ...f.scope,
    filter: 'all',
    limit: 100,
  });
  expect(items).toMatchObject([
    { noticeKind: 'connection_attention', subjectId: id },
  ]);
});

/** A notice from when the grant was lost, then the code the connection has now. */
async function mailedAfter(code: string): Promise<number> {
  const f = await seedNoticeWorkspace();
  await preferences().replace({
    ...f.scope,
    mode: 'immediate',
    hour: 9,
    timeZone: 'UTC',
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const id = await newOAuth2Connection(f.workspaceId, f.members.owner);
  await setErrorCode(f.workspaceId, id, GRANT_LOST);
  await observer().observeCurrent?.();
  await setErrorCode(f.workspaceId, id, code);
  const captured: NoticeMailToSeal[] = [];
  await mail(captured).prepare();
  return captured.filter(({ workspaceId }) => workspaceId === f.workspaceId)
    .length;
}

it('a connection still without its grant is mailed to its manager', async () => {
  expect(await mailedAfter(GRANT_LOST)).toBe(1);
});

// M4: replacing a client's settings returns it to not connected: no longer worth a mail.
it('M4 a connection back to not connected is not mailed', async () => {
  expect(await mailedAfter(NOT_CONNECTED)).toBe(0);
});
