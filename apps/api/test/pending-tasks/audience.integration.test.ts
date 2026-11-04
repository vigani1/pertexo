import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

const api = useBetterAuthRealApi('task_audience');
describe.runIf(betterAuthIntegrationEnabled)(
  'task audience directory composition',
  () => {
    it('returns a bounded names-only directory and refuses the same browser after editing authority is lost', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Task audience', slug: `audience-${randomUUID()}` },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      await api
        .database()
        .query(
          `with people as (insert into app.users(id,email,display_name) select gen_random_uuid(),'audience-'||gen_random_uuid()||'@example.test','Audience member' from generate_series(1,60) returning id) insert into app.workspace_memberships(workspace_id,user_id,role,status) select $1,id,'admin','active' from people`,
          [workspaceId],
        );
      const url = `/v1/workspaces/${workspaceId}/pending-tasks/audience?q=`;
      const read = await api.send('GET', url, { browser });
      expect(read.statusCode, read.payload).toBe(200);
      const page = read.json<{
        items: { userId: string; displayName: string; role: string }[];
        nextCursor: string | null;
      }>();
      expect(page.items).toHaveLength(50);
      expect(page.nextCursor).toBeTypeOf('string');
      expect(
        page.items.every(
          (item) =>
            Object.keys(item).sort().join(',') === 'displayName,role,userId',
        ),
      ).toBe(true);
      expect(read.payload).not.toContain('@example.test');
      await api
        .database()
        .query(
          `update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=(select id from app.users where email=$2)`,
          [workspaceId, email],
        );
      const denied = await api.send('GET', url, { browser });
      expect(denied.statusCode, denied.payload).toBe(404);
      expect(denied.payload).not.toContain('Audience member');
    });
  },
);
