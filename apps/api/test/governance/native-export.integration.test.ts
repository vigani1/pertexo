import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'native audit export recovery',
  () => {
    const api = useBetterAuthRealApi('native_audit_export');
    it('returns a safe sign-in recovery page for a refused native submission while JSON clients retain problem details', async () => {
      const path = `/v1/workspaces/${randomUUID()}/governance/audit/export`;
      const native = await api.send('POST', path, {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html',
        },
        payload: 'payload=%7B%7D&csrfToken=synthetic',
      });
      expect(native.statusCode, native.payload).toBe(401);
      expect(native.headers['content-type']).toContain('text/html');
      expect(native.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      expect(native.payload).toContain(
        'Your session ended. Sign in again before exporting the audit log.',
      );
      expect(native.payload).toContain('Sign in');
      expect(native.payload).not.toContain('auth.unauthenticated');
      expect(native.payload).not.toContain('<script');
      const json = await api.send('POST', path, { payload: {} });
      expect(json.statusCode).toBe(401);
      expect(json.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(json.json()).toMatchObject({ code: 'auth.unauthenticated' });
    });
    it('keeps native exports streamed and turns CSRF refusals into safe recovery pages', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Audit recovery',
          slug: `audit-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const path = `/v1/workspaces/${workspaceId}/governance/audit/export`;
      const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
      };
      const refused = await api.send('POST', path, {
        browser,
        headers,
        payload: new URLSearchParams({
          payload: '{}',
          csrfToken: 'invalid-synthetic-token',
        }).toString(),
      });
      expect(refused.statusCode, refused.payload).toBe(403);
      expect(refused.headers['content-type']).toContain('text/html');
      expect(refused.payload).toContain('Choose a workspace');
      expect(refused.payload).not.toContain('invalid-synthetic-token');
      const completed = await api.send('POST', path, {
        browser,
        headers,
        payload: new URLSearchParams({
          payload: '{}',
          csrfToken: browser.csrf,
        }).toString(),
      });
      expect(completed.statusCode, completed.payload).toBe(200);
      expect(completed.headers['content-type']).toContain('text/csv');
      expect(completed.headers['content-disposition']).toContain('attachment');
      expect(completed.payload).toContain('workspace.created');
    });
  },
);
