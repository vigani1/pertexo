import { randomUUID } from 'node:crypto';

import { RedisWorkspaceInboxHintPublisher } from '@pertexo/queue';
import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  origin,
  useBetterAuthRealApi,
  type Browser,
} from '../support/better-auth-real-api.integration.support.js';

const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

/*
 * ADR 055 through the whole HTTP stack: Better Auth sessions, the capability
 * guard, row-level security on a disposable database, private read state and
 * the live hint stream over real Redis.
 */
describe.runIf(betterAuthIntegrationEnabled)(
  'workspace inbox through the API',
  () => {
    const api = useBetterAuthRealApi('inbox', { notifications: true });
    const { send, signIn, signUp } = api;

    async function person(): Promise<
      Readonly<{ id: string; browser: Browser }>
    > {
      const email = `${randomUUID()}@example.test`;
      await signUp(email, '/login?verified=true');
      const browser = await signIn(email);
      const me = await send('GET', '/v1/users/me', { browser });
      return { id: me.json<{ id: string }>().id, browser };
    }

    /** A workspace whose workflow failed once, folded into its thread. */
    async function failingWorkspace() {
      const owner = await person();
      const operator = await person();
      const builder = await person();
      const created = await send('POST', '/v1/workspaces', {
        browser: owner.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Inbox team',
          slug: `inbox-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const workflowId = randomUUID();
      const runId = randomUUID();
      const database = api.database();
      for (const [member, role] of [
        [operator, 'operator'],
        [builder, 'builder'],
      ] as const)
        await database.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status)
             values($1,$2,$3,'active')`,
          [workspaceId, member.id, role],
        );
      await database.query(
        'insert into app.workflows (id,workspace_id,name,created_by) values ($1,$2,$3,$4)',
        [workflowId, workspaceId, 'Nightly import', owner.id],
      );
      await database.query(
        `insert into app.workspace_execution_entitlement_versions
           (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
         values ($1,2,'active',10,100,'-infinity'::timestamptz)`,
        [workspaceId],
      );
      await database.query(
        'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
        [workspaceId],
      );
      await database.query(
        `with tenant as (select set_config('app.workspace_id',$2::uuid::text,true))
         insert into app.workflow_runs (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
         select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'manual','failed' from tenant`,
        [runId, workspaceId, workflowId, randomUUID()],
      );
      await database.query(
        `insert into app.workspace_inbox_events
           (id,workspace_id,workflow_id,run_id,terminal_event_sequence,kind,occurred_at)
         values ($1,$2,$3,$4,3,'failed',clock_timestamp())`,
        [randomUUID(), workspaceId, workflowId, runId],
      );
      await database.query(
        'select * from app.fold_workspace_inbox_events(100)',
      );
      return {
        workspaceId,
        workflowId,
        runId,
        owner: owner.browser,
        operator: operator.browser,
        builder: builder.browser,
      };
    }

    it('shows each eligible reader the thread with private read state', async () => {
      const { workspaceId, workflowId, runId, owner, operator, builder } =
        await failingWorkspace();
      const base = `/v1/workspaces/${workspaceId}/notifications`;

      const listed = await send('GET', base, { browser: owner });
      expect(listed.statusCode, listed.payload).toBe(200);
      const page = listed.json<{
        items: { workflowId: string; revision: string; unread: boolean }[];
        revision: string;
      }>();
      expect(page.items).toEqual([
        expect.objectContaining({
          workflowId,
          workflowName: 'Nightly import',
          kind: 'failed',
          occurrenceCount: 1,
          latestRunId: runId,
          unread: true,
        }),
      ]);
      const revision = page.items[0]?.revision ?? '0';

      expect(
        (await send('GET', `${base}/summary`, { browser: builder })).statusCode,
      ).toBe(404);

      const read = await send('POST', `${base}/${workflowId}/read`, {
        browser: operator,
        payload: { revision },
      });
      expect(read.statusCode, read.payload).toBe(200);
      expect(read.json()).toEqual({ workflowId, unread: false, revision });
      expect(
        (await send('GET', `${base}/summary`, { browser: operator })).json(),
      ).toEqual({ unreadCount: 0, revision });
      // Reading is private: the owner still has it unread.
      expect(
        (await send('GET', `${base}/summary`, { browser: owner })).json(),
      ).toEqual({ unreadCount: 1, revision });

      const readAll = await send('POST', `${base}/read-all`, {
        browser: owner,
        payload: { revision: page.revision },
      });
      expect(readAll.json()).toEqual({ marked: 1 });
      expect(
        (await send('GET', `${base}?filter=unread`, { browser: owner })).json(),
      ).toMatchObject({ items: [] });

      const withoutCsrf = await send('POST', `${base}/read-all`, {
        headers: { cookie: owner.cookie },
        payload: { revision: page.revision },
      });
      expect(withoutCsrf.statusCode).toBe(403);
    });

    it('streams a hint when the worker reports a change', async () => {
      const { workspaceId, owner } = await failingWorkspace();
      const url = await api.listen();
      const controller = new AbortController();
      const publisher = new RedisWorkspaceInboxHintPublisher({ redisUrl });
      try {
        const response = await fetch(
          `${url}/v1/workspaces/${workspaceId}/notifications/events`,
          {
            headers: { cookie: owner.cookie, origin },
            signal: controller.signal,
          },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        const reader = (
          response.body as ReadableStream<Uint8Array> | null
        )?.getReader();
        if (reader === undefined) throw new Error('Expected a stream body');
        const decoder = new TextDecoder();
        let received = '';
        const readUntil = async (text: string) => {
          while (!received.includes(text)) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Stream ended early');
            received += decoder.decode(chunk.value, { stream: true });
          }
        };
        await readUntil('event: inbox.ready');
        await publisher.publish({ workspaceId, revision: '77' });
        await readUntil('event: inbox.changed');
        expect(received).toContain('data: {"schemaVersion":1,"revision":"77"}');
        expect(received).not.toContain('Nightly import');
      } finally {
        controller.abort();
        await publisher.close();
      }
    });
  },
);
