import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createTokenWorkspace } from '../api-tokens/api/portability/setup.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'connection input error privacy on the real API',
  () => {
    const api = useBetterAuthRealApi('connection_input_privacy', {
      automationTokens: true,
      connections: {
        config: {
          kmsKeyReference: 'input-privacy-fixture',
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
    it('returns useful input pointers without echoing a credential body or storing it', async () => {
      const w = await createTokenWorkspace({ api, listen: () => api.listen() }),
        canary = 'private-connection-credential-canary';
      const reply = await api.send('POST', `${w.base}/connections`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          providerKey: 'http',
          name: '',
          credential: {
            type: 'headers',
            headers: [{ name: 'Authorization', value: `Bearer ${canary}` }],
          },
        },
      });
      expect(reply.statusCode, reply.payload).toBe(400);
      const problem = reply.json<{ errors: { path: string }[] }>();
      expect(problem.errors.map((issue) => issue.path)).toContain('/name');
      expect(reply.payload).not.toContain(canary);
      expect(reply.payload).not.toContain('Bearer');
      expect(
        (
          await api
            .database()
            .query('select id from app.connections where workspace_id=$1', [
              w.workspaceId,
            ])
        ).rows,
      ).toEqual([]);
    });
  },
);
