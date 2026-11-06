import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'stored variable set corruption',
  () => {
    const api = useBetterAuthRealApi('stored_variables');
    it('reports damaged stored scalars as a server failure, not invalid caller input', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: {
          name: 'Stored variables',
          slug: `stored-vars-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      const workspaceId = workspace.json<{ id: string }>().id;
      const path = `/v1/workspaces/${workspaceId}/variables`;
      const saved = await api.send('PUT', path, {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: { expectedRevision: 0, values: { RATE: 1 } },
      });
      expect(saved.statusCode, saved.payload).toBe(200);
      await api
        .database()
        .query(
          `update app.workspace_variable_set_revisions set values_json='{"RATE":{"damaged":true}}'::jsonb where workspace_id=$1`,
          [workspaceId],
        );
      const response = await api.send('GET', path, { browser });
      expect(response.statusCode, response.payload).toBe(500);
      expect(response.json<{ code: string }>().code).toBe(
        'internal.unexpected',
      );
      expect(response.payload).not.toContain('damaged');
    });
  },
);
