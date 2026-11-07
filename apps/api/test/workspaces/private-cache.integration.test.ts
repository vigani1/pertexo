import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/secrets/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'private response cache protection',
  () => {
    const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      randomBytes(32),
      'connection',
    );
    const api = useBetterAuthRealApi('private_cache', {
      notifications: true,
      connections: {
        config: { kmsKeyReference: 'owned-cache-fixture', region: 'us-east-1' },
        services: () => ({
          encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
        }),
      },
    });
    it('protects ordinary private reads and refusals while preserving public responses', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Cache privacy', slug: `cache-${randomUUID()}` },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      const id = workspace.json<{ id: string }>().id;
      for (const path of [
        `/v1/workspaces/${id}/workflows`,
        `/v1/workspaces/${id}/runs`,
        `/v1/workspaces/${id}/connections`,
        `/v1/workspaces/${id}/notifications`,
        `/v1/workspaces/${id}/notifications/summary`,
        `/v1/workspaces/${id}/previews/${randomUUID()}`,
        '/v1/users/me',
      ]) {
        const reply = await api.send('GET', path, { browser });
        expect(reply.statusCode, reply.payload).toBeLessThan(500);
        expect(reply.headers['cache-control'], path).toBe('private, no-store');
        const refused = await api.send('GET', path);
        expect(refused.statusCode).toBe(401);
        expect(refused.headers['cache-control'], path).toBe(
          'private, no-store',
        );
      }
      const native = await api.send('GET', '/v1/auth/account-security', {
        browser,
      });
      expect(native.statusCode, native.payload).toBe(200);
      expect(native.headers['cache-control']).toContain('no-store');
      const created = await api.send('POST', `/v1/workspaces/${id}/workflows`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Conditional privacy' },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workflowId = created.json<{ workflow: { id: string } }>().workflow
        .id;
      const draft = `/v1/workspaces/${id}/workflows/${workflowId}/draft`;
      const read = await api.send('GET', draft, { browser });
      expect(read.statusCode, read.payload).toBe(200);
      expect(read.headers.etag).toBeTypeOf('string');
      const conditional = await api.send('GET', draft, {
        browser,
        headers: { 'if-none-match': String(read.headers.etag) },
      });
      expect(conditional.statusCode, conditional.payload).toBe(304);
      expect(conditional.headers['cache-control']).toBe('private, no-store');
      const publicReply = await api.send('GET', '/health/live');
      expect(publicReply.statusCode).toBe(200);
      expect(publicReply.headers['cache-control']).not.toBe(
        'private, no-store',
      );
    });
  },
);
