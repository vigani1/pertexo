import { randomBytes, randomUUID } from 'node:crypto';
import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/secrets/server';
import { describe, expect, it } from 'vitest';
import { createEditorBrowserEnvelopeKeys } from '../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createPreviewBoundary } from '../node-testing/preview-boundary.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'connection rotation conflict meaning',
  () => {
    const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      randomBytes(32),
      'connection',
    );
    const encryption = new ConnectionEnvelopeEncryption(keys);
    const api = useBetterAuthRealApi('rotation_conflicts', {
      connections: {
        config: {
          kmsKeyReference: 'owned-conflict-fixture',
          region: 'us-east-1',
        },
        services: () => ({
          encryption: {
            encryption,
            close: () => {
              keys.close();
            },
          },
        }),
      },
    });
    it('refuses unregistered provider and auth pairs at create and rotation', async () => {
      const f = await createPreviewBoundary(api);
      const base = `${f.root}/connections`;
      const credential = {
        type: 'http_headers',
        headers: { authorization: 'fixture' },
      };
      const options = () => ({
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
      });
      for (const [providerKey, proposed, path] of [
        ['future_provider', credential, '/providerKey'],
        ['slack', credential, '/credential/type'],
        ['http', { type: 'future_auth' }, '/credential/type'],
      ] as const) {
        const refused = await api.send('POST', base, {
          ...options(),
          payload: {
            providerKey,
            name: 'Unregistered pair',
            credential: proposed,
          },
        });
        expect(refused.statusCode, refused.payload).toBe(400);
        expect(refused.json()).toMatchObject({
          code: 'request.invalid',
          errors: [expect.objectContaining({ path })],
        });
      }
      const made = await api.send('POST', base, {
        ...options(),
        payload: { providerKey: 'http', name: 'Registered pair', credential },
      });
      expect(made.statusCode, made.payload).toBe(201);
      const { id, secretVersionId } = made.json<{
        id: string;
        secretVersionId: string;
      }>();
      const refused = await api.send('PUT', `${base}/${id}/secret`, {
        ...options(),
        payload: {
          expectedSecretVersionId: secretVersionId,
          credential: { type: 'future_auth' },
        },
      });
      expect(refused.statusCode, refused.payload).toBe(400);
      expect(refused.json()).toMatchObject({
        code: 'request.invalid',
        errors: [expect.objectContaining({ path: '/credential/type' })],
      });
      const stored = await api.send('GET', `${base}/${id}`, {
        browser: f.browser,
      });
      expect(stored.statusCode, stored.payload).toBe(200);
      expect(stored.json()).toMatchObject({ secretVersionId });
    });

    it('lists and revokes a stored unknown key and refuses to use its credential', async () => {
      const f = await createPreviewBoundary(api);
      const base = `${f.root}/connections`;
      const id = randomUUID();
      const versionId = randomUUID();
      const sealed = await encryption.seal(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'http_headers',
            headers: { authorization: 'Bearer unknown-key-fixture' },
          }),
        ),
        {
          workspaceId: f.workspaceId,
          connectionId: id,
          secretVersionId: versionId,
        },
      );
      const client = await api.database().connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
           select $1,id,'http','Future credential','future_auth','active',$2,created_by
             from app.workspaces where id=$3`,
          [id, versionId, f.workspaceId],
        );
        await client.query(
          `insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
           select $1,id,$2,$4,$5,$6,$7,$8,created_by
             from app.workspaces where id=$3`,
          [
            versionId,
            id,
            f.workspaceId,
            sealed.kmsKeyReference,
            sealed.encryptedDataKey,
            sealed.ciphertext,
            sealed.nonce,
            sealed.tag,
          ],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      const listed = await api.send('GET', base, { browser: f.browser });
      expect(listed.statusCode, listed.payload).toBe(200);
      expect(listed.json()).toMatchObject({
        items: [
          expect.objectContaining({
            id,
            authType: 'future_auth',
            status: 'active',
          }),
        ],
      });
      const refused = await api.send('POST', `${base}/${id}/test`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { url: 'https://provider.example.test/health' },
      });
      expect(refused.statusCode, refused.payload).toBe(503);
      expect(refused.json()).toMatchObject({
        code: 'provider.unavailable',
        detail: 'Credential protection is temporarily unavailable.',
      });
      const revoked = await api.send('DELETE', `${base}/${id}`, {
        browser: f.browser,
      });
      expect(revoked.statusCode, revoked.payload).toBe(200);
      expect(revoked.json()).toMatchObject({
        id,
        authType: 'future_auth',
        status: 'revoked',
      });
    });

    it('keeps an active credential usable after an incompatible type refusal and reserves revoked for revocation', async () => {
      const f = await createPreviewBoundary(api);
      const made = await api.send('POST', `${f.root}/connections`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          providerKey: 'http',
          name: 'Working headers',
          credential: {
            type: 'http_headers',
            headers: { Authorization: 'Bearer local-fixture-secret' },
          },
        },
      });
      expect(made.statusCode, made.payload).toBe(201);
      const original = made.json<{ id: string; secretVersionId: string }>();
      const rotate = () =>
        api.send('PUT', `${f.root}/connections/${original.id}/secret`, {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            expectedSecretVersionId: original.secretVersionId,
            credential: {
              type: 'slack_bot_token',
              botToken: 'xoxb-owned-fixture-token-1',
            },
          },
        });
      const conflict = await rotate();
      expect(conflict.statusCode, conflict.payload).toBe(409);
      expect(conflict.json()).toMatchObject({
        code: 'connection.conflict',
      });
      expect(conflict.json<{ detail: string }>().detail).toMatch(
        /authentication type/i,
      );
      const read = await api.send(
        'GET',
        `${f.root}/connections/${original.id}`,
        { browser: f.browser },
      );
      expect(read.statusCode, read.payload).toBe(200);
      expect(read.json()).toMatchObject({
        status: 'active',
        secretVersionId: original.secretVersionId,
      });
      expect(
        (
          await api.send('DELETE', `${f.root}/connections/${original.id}`, {
            browser: f.browser,
          })
        ).statusCode,
      ).toBe(200);
      const revoked = await rotate();
      expect(revoked.statusCode, revoked.payload).toBe(409);
      expect(revoked.json()).toMatchObject({ code: 'connection.revoked' });
    });
  },
);
