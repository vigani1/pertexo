import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';

const api = useBetterAuthRealApi('cancel_standing');
describe.runIf(betterAuthIntegrationEnabled)(
  'run cancellation workspace standing',
  () => {
    it.each(['suspended', 'pending_deletion'] as const)(
      'lets its owner stop a retained run in a %s workspace through HTTP',
      async (status) => {
        const email = `${randomUUID()}@example.test`;
        await api.signUp(email, '/login?verified=true');
        let browser = await api.signIn(email);
        const workspace = await api.send('POST', '/v1/workspaces', {
          browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            name: 'Stop retained work',
            slug: `cancel-${randomUUID()}`,
          },
        });
        expect(workspace.statusCode, workspace.payload).toBe(201);
        const workspaceId = workspace.json<{ id: string }>().id;
        const base = `/v1/workspaces/${workspaceId}`;
        const created = await api.send('POST', `${base}/workflows`, {
          browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Retained run' },
        });
        expect(created.statusCode, created.payload).toBe(201);
        const workflowId = created.json<{ workflow: { id: string } }>().workflow
          .id;
        const path = `${base}/workflows/${workflowId}`;
        const saved = await api.send('PUT', `${path}/draft`, {
          browser,
          headers: { 'if-match': String(created.headers.etag) },
          payload: {
            graph: {
              settings: {},
              edges: [],
              nodes: [
                {
                  id: randomUUID(),
                  definition: { key: 'core.manual', version: 1 },
                  configVersion: 1,
                  config: {},
                  inputMappings: {},
                  connectionRefs: {},
                  position: { x: 0, y: 0 },
                },
              ],
            },
          },
        });
        expect(saved.statusCode, saved.payload).toBe(200);
        const published = await api.send('POST', `${path}/publish`, {
          browser,
          headers: {
            'if-match': String(saved.headers.etag),
            'idempotency-key': randomUUID(),
          },
          payload: {},
        });
        expect(published.statusCode, published.payload).toBe(200);
        const started = await api.send('POST', `${path}/runs`, {
          browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { input: {} },
        });
        expect(started.statusCode, started.payload).toBe(202);
        const runId = started.json<{ run: { id: string } }>().run.id;
        await api.database().query(
          `update app.workspaces set status=$1::text,
            deletion_requested_at=case when $1::text='pending_deletion' then now() end,
            deletion_requested_by=case when $1::text='pending_deletion' then created_by end,
            deletion_reason=case when $1::text='pending_deletion' then 'Fixture deletion request' end,
            purge_after=case when $1::text='pending_deletion' then now()+interval '7 days' end where id=$2`,
          [status, workspaceId],
        );
        // Workspace unavailability revokes sessions; the global account can sign in
        // again to use the API's retained-workspace cancellation permission.
        browser = await api.signIn(email);
        const cancel = () =>
          api.send('POST', `${base}/runs/${runId}/cancel`, {
            browser,
            payload: { reason: 'Stop this retained work' },
          });
        const response = await cancel();
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.json()).toMatchObject({
          alreadyRequested: false,
          run: { id: runId, cancelRequestedAt: expect.any(String) as unknown },
        });
        const repeat = await cancel();
        expect(repeat.statusCode, repeat.payload).toBe(200);
        expect(repeat.json()).toMatchObject({ alreadyRequested: true });
        expect(
          (
            await api
              .database()
              .query(
                `select cancel_reason,cancel_requested_at is not null requested from app.workflow_runs where id=$1`,
                [runId],
              )
          ).rows,
        ).toEqual([
          { cancel_reason: 'Stop this retained work', requested: true },
        ]);
        expect(
          (
            await api
              .database()
              .query(
                `select count(*)::int n from app.run_events where workflow_run_id=$1 and type='run.cancel_requested'`,
                [runId],
              )
          ).rows,
        ).toEqual([{ n: 1 }]);
        const refused = await api.send('POST', `${path}/runs`, {
          browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { input: {} },
        });
        expect(refused.statusCode, refused.payload).toBe(404);
        expect(refused.json()).toMatchObject({ code: 'resource.not_found' });
        expect(
          (
            await api
              .database()
              .query(
                'select count(*)::int n from app.workflow_runs where workflow_id=$1',
                [workflowId],
              )
          ).rows,
        ).toEqual([{ n: 1 }]);
      },
    );
  },
);
