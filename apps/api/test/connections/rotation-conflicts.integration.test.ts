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
    const api = useBetterAuthRealApi('rotation_conflicts', {
      connections: {
        config: {
          kmsKeyReference: 'owned-conflict-fixture',
          region: 'us-east-1',
        },
        services: () => {
          const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
            randomBytes(32),
            'connection',
          );
          return {
            encryption: {
              encryption: new ConnectionEnvelopeEncryption(keys),
              close: () => {
                keys.close();
              },
            },
          };
        },
      },
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
