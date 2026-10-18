import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  workflowCommentCommandResultSchema,
  workflowCommentDetailSchema,
  workflowPresenceSchema,
} from '@pertexo/contracts';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';
describe.runIf(betterAuthIntegrationEnabled)(
  'workflow discussion and presence HTTP boundary',
  () => {
    const api = useBetterAuthRealApi('collaboration');
    it('uses sessions and CSRF, retains command identity, and refuses stale comments without overwriting', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const owner = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Discussion proof',
          slug: 'discussion-' + randomUUID().slice(0, 8),
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      const workspaceId = workspace.json<{ id: string }>().id;
      const created = await api.send(
        'POST',
        `/v1/workspaces/${workspaceId}/workflows`,
        {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Discuss this workflow' },
        },
      );
      const workflowId = created.json<{ workflow: { id: string } }>().workflow
        .id;
      const base = `/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
      expect((await api.send('GET', base + '/comments')).statusCode).toBe(401);
      const invalid = await api.send('POST', base + '/comments', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { body: 'x'.repeat(8001) },
      });
      expect(invalid.statusCode, invalid.payload).toBe(400);
      const headers = { 'idempotency-key': randomUUID() },
        payload = { body: 'Please check this', mentionUserIds: [] };
      const posted = await api.send('POST', base + '/comments', {
        browser: owner,
        headers,
        payload,
      });
      expect(posted.statusCode, posted.payload).toBe(201);
      const comment = workflowCommentCommandResultSchema.parse(posted.json());
      const commentId = comment.commentId;
      if (commentId === null) throw new Error('Comment missing');
      const retry = await api.send('POST', base + '/comments', {
        browser: owner,
        headers,
        payload,
      });
      expect(retry.json()).toEqual({ ...comment, replayed: true });
      const url = base + '/comments/' + comment.threadId;
      const read = await api.send('GET', url, { browser: owner });
      expect(read.statusCode, read.payload).toBe(200);
      expect(read.headers['cache-control']).toBe('private, no-store');
      expect(
        workflowCommentDetailSchema.parse(read.json()).comments,
      ).toMatchObject([{ body: payload.body, revision: 1 }]);
      const edit = () =>
        api.send('PUT', url + '/comments/' + commentId, {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { body: 'Keep local text', expectedRevision: 1 },
        });
      expect((await edit()).statusCode).toBe(200);
      const stale = await edit();
      expect(stale.statusCode, stale.payload).toBe(409);
      expect(stale.json<{ code: string }>().code).toBe(
        'workflow.collaboration_conflict',
      );
      const tabId = randomUUID();
      const heartbeat = await api.send('PUT', base + '/presence/' + tabId, {
        browser: owner,
        payload: { sequence: 2, editing: true, dirty: true, baseRevision: 1 },
      });
      expect(heartbeat.statusCode, heartbeat.payload).toBe(200);
      expect(heartbeat.json()).toEqual({ accepted: true });
      const older = await api.send('PUT', base + '/presence/' + tabId, {
        browser: owner,
        payload: {
          sequence: 1,
          editing: false,
          dirty: false,
          baseRevision: null,
        },
      });
      expect(older.json()).toEqual({ accepted: false });
      const presence = await api.send(
        'GET',
        base + '/presence?tabId=' + randomUUID(),
        { browser: owner },
      );
      expect(
        workflowPresenceSchema.parse(presence.json()).people,
      ).toMatchObject([{ editing: true, dirty: true, tabCount: 1 }]);
      expect(
        (
          await api.send('DELETE', base + '/presence/' + tabId, {
            browser: owner,
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await api.send('GET', base + '/presence?tabId=invalid', {
            browser: owner,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await api.send('GET', base + '/comments/not-an-id', {
            browser: owner,
          })
        ).statusCode,
      ).toBe(400);
    });
  },
);
