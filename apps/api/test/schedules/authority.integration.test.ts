import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createPreviewBoundary } from '../node-testing/preview-boundary.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'schedule request authority',
  () => {
    const api = useBetterAuthRealApi('schedule_authority', { schedules: true });
    it('returns a safe hidden-resource refusal and accepts no schedule command for a nonmember', async () => {
      const f = await createPreviewBoundary(api);
      const outsider = `${randomUUID()}@example.test`;
      await api.signUp(outsider, '/workspaces');
      const browser = await api.signIn(outsider);
      const response = await api.send(
        'POST',
        `${f.root}/workflows/${f.workflowId}/triggers/${randomUUID()}/schedule/enable`,
        { browser, headers: { 'idempotency-key': randomUUID() }, payload: {} },
      );
      expect(response.statusCode, response.payload).toBe(404);
      expect(response.json()).toMatchObject({ code: 'resource.not_found' });
      const rows = await api
        .database()
        .query(
          "select count(*)::int count from app.idempotency_records where workspace_id=$1 and operation='schedule.trigger.setenabled'",
          [f.workspaceId],
        );
      expect(rows.rows).toEqual([{ count: 0 }]);
    });
  },
);
