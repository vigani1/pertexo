import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../../support/oauth2/harness.js';

useOAuth2Timeouts();

const ONE_HOUR_S = 3_600;

describeOAuth2('what an OAuth2 connection stores', () => {
  let harness: OAuth2Harness;

  beforeAll(async () => {
    harness = await startOAuth2Harness('life-stored');
  });
  afterAll(async () => {
    await harness.close();
  });

  const replace = (owner: Owner, connection: Connection, credential: unknown) =>
    owner.api.call(
      'PUT',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/secret`,
      { expectedSecretVersionId: connection.secretVersionId, credential },
      { 'idempotency-key': randomUUID() },
    );

  const revoke = (owner: Owner, connection: Connection) =>
    owner.api.call(
      'DELETE',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}`,
    );

  const usedStep = (connection: Connection) =>
    ({
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
    }) as const;

  // S19: the client secret is sealed in connection_secret_versions.
  it('S19 stores the client secret sealed, not in settings', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const [row] = await harness.stack.sql<{ stored: string }>(
      `select (select settings::text from app.connection_oauth2_clients where connection_id=$1)
              || (select ciphertext::text from app.connection_secret_versions where connection_id=$1)
              as stored`,
      [connection.id],
    );
    expect(row?.stored).toBeTruthy();
    expect(row?.stored).not.toContain(connection.clientSecret);
  });

  // Plan, Detail: the grant facts answered, one per kind of service.
  it('answers its grant: renewable, with a lifetime by database time', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    const read = await harness.read(owner.api, owner, connection.id);
    expect(read.json).toMatchObject({
      status: 'active',
      grant: {
        renewable: true,
        accessTokenExpiresAt: expect.any(String) as string,
      },
    });
    const { grant } = read.json as {
      grant: { accessTokenExpiresAt: string };
    };
    const remaining =
      (new Date(grant.accessTokenExpiresAt).getTime() - Date.now()) / 1_000;
    expect(remaining).toBeGreaterThan(ONE_HOUR_S - 120);
    expect(remaining).toBeLessThanOrEqual(ONE_HOUR_S + 120);
  });

  // L6, Detail: no refresh token means not renewable, with an expiry.
  it('answers not renewable when the service gave no refresh token', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'no-refresh');
    expect(
      (await harness.read(owner.api, owner, connection.id)).json,
    ).toMatchObject({
      grant: {
        renewable: false,
        accessTokenExpiresAt: expect.any(String) as string,
      },
    });
  });

  // L6, Detail: "The service gave no expiry".
  it('answers no expiry when the service gave none', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'no-expiry');
    expect(
      (await harness.read(owner.api, owner, connection.id)).json,
    ).toMatchObject({
      grant: { renewable: false, accessTokenExpiresAt: null },
    });
  });

  // L6: a numeric string counts as a lifetime, and anything else as absent.
  it('L6 reads expires_in as a number or numeric string, and nothing else', async () => {
    const owner = await harness.newOwner();
    const asString = await harness.connected(owner, 'expires-string');
    expect(
      (await harness.tokenRow(asString.id))?.access_token_expires_at,
    ).not.toBeNull();
    const asWord = await harness.connected(owner, 'expires-bad');
    expect(
      (await harness.tokenRow(asWord.id))?.access_token_expires_at,
    ).toBeNull();
  });

  // L6: up to 315,360,000, and anything above counts as absent.
  it('L6 treats an absurd lifetime as absent', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    harness.standIn.setExpiresIn(connection.clientId, 315_360_001);
    await harness.reconnect(owner, connection);
    expect(
      (await harness.tokenRow(connection.id))?.access_token_expires_at,
    ).toBeNull();
  });

  // L5: client credentials has no refresh token and is always renewable.
  it('L5 client credentials is always renewable', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.createServer(owner, 'non-rotating');
    const started = await harness.start(owner.api, owner, connection.id);
    expect(started.status).toBe(200);
    expect((await harness.tokenRow(connection.id))?.renewable).toBe(true);
  });

  // L7: a connection is active exactly when it has a token row for its current version.
  it('L7 holds after every step of a connection’s life', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'rotating');
    const holds = async (): Promise<void> => {
      const [row] = await harness.stack.sql<{
        status: string;
        token_for_current: boolean;
      }>(
        `select c.status, exists(
            select 1 from app.connection_oauth2_tokens t
             where t.connection_id=c.id
               and t.secret_version_id=c.current_secret_version_id
          ) as token_for_current
           from app.connections c where c.id=$1`,
        [connection.id],
      );
      expect(row?.token_for_current).toBe(row?.status === 'active');
    };
    await holds();
    await harness.reconnect(owner, connection);
    await holds();
    await harness.expireToken(connection.id);
    await harness.finish(await harness.run(owner, usedStep(connection)));
    await holds();
    harness.standIn.revoke(connection.clientId);
    await harness.expireToken(connection.id);
    await harness.finish(await harness.run(owner, usedStep(connection)));
    await holds();
    await harness.reconnect(owner, connection);
    await holds();
    const replaced = await replace(owner, connection, {
      type: 'oauth2',
      settings: harness.settings(connection.clientId),
      clientSecret: connection.clientSecret,
    });
    expect(replaced.status).toBe(200);
    await holds();
    await revoke(owner, connection);
    await holds();
  });

  // S19: a ciphertext copied to another connection won't open.
  it('S19 a token row copied to another connection won’t open', async () => {
    const owner = await harness.newOwner();
    const source = await harness.connected(owner, 'non-rotating');
    const target = await harness.connected(owner, 'non-rotating');
    await harness.stack.sql(
      `update app.connection_oauth2_tokens t
          set kms_key_reference=s.kms_key_reference, encrypted_data_key=s.encrypted_data_key,
              ciphertext=s.ciphertext, nonce=s.nonce, auth_tag=s.auth_tag
         from app.connection_oauth2_tokens s
        where t.connection_id=$1 and s.connection_id=$2`,
      [target.id, source.id],
    );
    const runId = await harness.run(owner, {
      connectionId: target.id,
      method: 'GET',
      url: harness.apiUrl(),
      retry: { maximumAttempts: 1, delayMillis: 1_000 },
    });
    expect((await harness.finish(runId)).status).toBe('failed');
    expect(harness.standIn.apiCalls(source.clientId)).toEqual([]);
    expect(harness.standIn.apiCalls(target.clientId)).toEqual([]);
  });

  // S19: the row's own id is in the authenticated data too.
  it('S19 a token row with a changed id won’t open', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.stack.sql(
      `update app.connection_oauth2_tokens set id=$2 where connection_id=$1`,
      [connection.id, randomUUID()],
    );
    const runId = await harness.run(owner, {
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
      retry: { maximumAttempts: 1, delayMillis: 1_000 },
    });
    expect((await harness.finish(runId)).status).toBe('failed');
    expect(harness.standIn.apiCalls(connection.clientId)).toEqual([]);
  });

  // D10: "startup refuses if a token's key is gone".
  it('D10 a worker refuses to start when a token’s key is gone', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.stack.sql(
      `update app.connection_oauth2_tokens set kms_key_reference='local:gone' where connection_id=$1`,
      [connection.id],
    );
    try {
      const worker = harness.stack.createWorker('oauth2-key-gone');
      worker.startOnce();
      await expect.poll(() => worker.exits.length, { timeout: 60_000 }).toBe(1);
      expect(worker.exits[0]?.code).not.toBe(0);
    } finally {
      // Other tests in this file start no worker, but keep the row honest anyway.
      await harness.stack.sql(
        `delete from app.connection_oauth2_tokens where connection_id=$1`,
        [connection.id],
      );
    }
  });
});
