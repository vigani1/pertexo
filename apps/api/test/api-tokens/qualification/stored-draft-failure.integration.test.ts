import { describe, expect, it } from 'vitest';
import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import { createAutomationApiFixture } from '../api/api-token-api.fixture.js';
import { createTokenWorkspace } from '../api/portability/setup.js';
describe.runIf(betterAuthIntegrationEnabled)(
  'stored draft failure provenance',
  () => {
    const fixture = createAutomationApiFixture(),
      { api } = fixture;
    it('treats malformed stored drafts as server failures without caller input errors', async () => {
      const w = await createTokenWorkspace(fixture);
      await api
        .database()
        .query(
          'update app.workflow_drafts set graph_json=\'{"private-corrupt-row":true}\' where workflow_id=$1',
          [w.workflowId],
        );
      const reply = await api.send(
        'GET',
        `${w.base}/workflows/${w.workflowId}/draft`,
        { headers: w.headers },
      );
      expect(reply.json()).not.toHaveProperty('errors');
      expect(reply.payload).not.toContain('private-corrupt-row');
      expect(reply.statusCode, reply.payload).toBe(500);
    });
  },
);
