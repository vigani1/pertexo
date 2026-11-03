import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createConnectionEnvelopeEncryption } from '@pertexo/secrets/server';
import { decodeStoredTokens } from '@pertexo/core/connections';
import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type OAuth2Harness,
  type Connection,
  type Owner,
} from '../support/oauth2/harness.js';

useOAuth2Timeouts();
describeOAuth2(
  'OAuth2 grants across consent and delayed provider failures',
  () => {
    let harness: OAuth2Harness;
    const encryption = createConnectionEnvelopeEncryption({
      mode: 'self-managed',
      encryption: {
        current: {
          version: 'local:development',
          key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
        },
        previous: [],
      },
    });
    beforeAll(async () => {
      harness = await startOAuth2Harness('grant-boundaries', {
        redisDatabase: 11,
      });
    });
    afterAll(async () => {
      encryption.close();
      await harness.close();
    });

    const step = (connection: Connection) => ({
      connectionId: connection.id,
      method: 'GET' as const,
      url: harness.apiUrl(),
      retry: { maximumAttempts: 1, delayMillis: 1_000 },
    });
    async function tokens(owner: Owner, connection: Connection) {
      const [row] = await harness.stack.sql<{
        id: string;
        kms_key_reference: string;
        encrypted_data_key: string;
        ciphertext: string;
        nonce: string;
        auth_tag: string;
      }>(
        'select id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag from app.connection_oauth2_tokens where connection_id=$1',
        [connection.id],
      );
      if (row === undefined) throw new Error('Token missing');
      const bytes = await encryption.encryption.open(
        {
          kmsKeyReference: row.kms_key_reference,
          encryptedDataKey: row.encrypted_data_key,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          tag: row.auth_tag,
        },
        {
          workspaceId: owner.workspaceId,
          connectionId: connection.id,
          secretVersionId: row.id,
        },
      );
      try {
        return decodeStoredTokens(bytes);
      } finally {
        bytes.fill(0);
      }
    }

    it('replaces account A’s complete grant with account B’s consent when B supplies no refresh token', async () => {
      const owner = await harness.newOwner();
      const connection = await harness.connected(owner, 'non-rotating');
      const accountA = await tokens(owner, connection);
      expect(accountA.refreshToken).toBeTruthy();
      harness.standIn.setBehavior(connection.clientId, 'no-refresh');
      expect((await harness.reconnect(owner, connection)).result).toBe(
        'connected',
      );
      const accountB = await tokens(owner, connection);
      expect(accountB.accessToken).not.toBe(accountA.accessToken);
      expect(accountB).not.toHaveProperty('refreshToken');
      expect(
        (await harness.read(owner.api, owner, connection.id)).json,
      ).toMatchObject({ grant: { renewable: false } });
      const exchanges = harness.standIn.tokenRequests(
        connection.clientId,
      ).length;
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, step(connection));
      expect((await harness.finish(runId)).status).toBe('failed');
      expect((await harness.attempts(runId))[0]?.safe_error_code).toBe(
        'http.oauth2_token_expired',
      );
      expect(harness.standIn.tokenRequests(connection.clientId)).toHaveLength(
        exchanges,
      );
      expect(harness.standIn.apiCalls(connection.clientId)).toEqual([]);
    });

    it.each(['expire', 'reconnect', 'revoke'] as const)(
      'rechecks the current grant after a held refresh fails across %s',
      async (change) => {
        const owner = await harness.newOwner();
        const connection = await harness.connected(owner, 'non-rotating');
        await harness.expireToken(connection.id, 30);
        harness.standIn.setBehavior(connection.clientId, '503');
        const hold = harness.standIn.holdNextToken(connection.clientId);
        let runId = '';
        try {
          runId = await harness.run(owner, step(connection));
          await hold.arrived;
          if (change === 'expire') await harness.expireToken(connection.id);
          if (change === 'reconnect') {
            harness.standIn.setBehavior(connection.clientId, 'non-rotating');
            expect((await harness.reconnect(owner, connection)).result).toBe(
              'connected',
            );
          }
          if (change === 'revoke') {
            const revoked = await owner.api.call(
              'DELETE',
              `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}`,
            );
            expect(revoked.status).toBe(200);
          }
          hold.release();
          const ended = await harness.finish(runId);
          if (change === 'reconnect') {
            expect(ended.status).toBe('succeeded');
            const current = await tokens(owner, connection);
            expect(
              harness.standIn
                .apiCalls(connection.clientId)
                .map((call) => call.headers.authorization),
            ).toEqual([`Bearer ${current.accessToken}`]);
          } else {
            expect(ended.status).toBe('failed');
            expect(harness.standIn.apiCalls(connection.clientId)).toEqual([]);
            if (change === 'expire')
              expect((await harness.attempts(runId))[0]?.safe_error_code).toBe(
                'http.oauth2_token_endpoint_unavailable',
              );
          }
        } finally {
          hold.release();
        }
      },
    );

    it('settles a network-failed OAuth2 connection test and replays its completed result on the same key', async () => {
      const owner = await harness.newOwner();
      const connection = await harness.connected(owner, 'non-rotating');
      const key = randomUUID();
      const test = (idempotencyKey: string) =>
        owner.api.call(
          'POST',
          `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/test`,
          { url: 'https://api.public.example.test/network-failure' },
          { 'idempotency-key': idempotencyKey },
        );
      const first = await test(key);
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      expect(first.json).toMatchObject({
        outcome: { errorCode: 'connection.test.network_failed', ok: false },
      });
      const replay = await test(key);
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual(first.json);
      expect(
        await harness.stack.sql(
          "select status from app.idempotency_records where resource_id=$1 and operation='connection.test'",
          [connection.id],
        ),
      ).toEqual([{ status: 'completed' }]);
      expect((await test(randomUUID())).status).toBe(200);
    });
  },
);
