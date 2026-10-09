import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  workflowConcurrencySettingsSchema,
  workflowConcurrencyRevisionConflictProblemSchema,
  workflowConcurrencyLimitExceededProblemSchema,
  type WorkflowConcurrencyCommandResponse,
} from '@pertexo/contracts';
import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
} from '../../support/better-auth-real-api.integration.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'authenticated operational workflow concurrency controls',
  () => {
    const api = useBetterAuthRealApi('workflow-concurrency');
    async function fixture() {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const owner = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Concurrency proof',
          slug: `concurrency-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const workflow = await api.send(
        'POST',
        `/v1/workspaces/${workspaceId}/workflows`,
        {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Queue-only workflow' },
        },
      );
      expect(workflow.statusCode, workflow.payload).toBe(201);
      const workflowId = workflow.json<{ workflow: { id: string } }>().workflow
        .id;
      return {
        email,
        owner,
        workspaceId,
        workflowId,
        route: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/concurrency`,
      };
    }
    it('requires session, CSRF, one command key and strict queue-only bodies', async () => {
      const { owner, route } = await fixture();
      const payload = { limit: null, expectedRevision: 1 };
      expectProblem(await api.send('GET', route), 401, 'auth.unauthenticated');
      expectProblem(
        await api.send('PUT', route, {
          headers: { cookie: owner.cookie, 'idempotency-key': 'without-csrf' },
          payload,
        }),
        403,
        'auth.forbidden',
      );
      for (const headers of [{}, { 'idempotency-key': 'one,two' }])
        expectProblem(
          await api.send('PUT', route, { browser: owner, headers, payload }),
          400,
          'request.invalid',
        );
      for (const invalid of [
        { ...payload, limit: 0 },
        { ...payload, expectedRevision: 0 },
        { ...payload, overflow: 'skip' },
        { ...payload, queueLength: 10 },
      ])
        expectProblem(
          await api.send('PUT', route, {
            browser: owner,
            headers: { 'idempotency-key': randomUUID() },
            payload: invalid,
          }),
          400,
          'request.invalid',
        );
    });
    it('preserves exact replay/CAS, no-op revision and removal with no execution entitlement', async () => {
      const { owner, route, workspaceId, workflowId } = await fixture();
      const fresh = await api.send('GET', route, { browser: owner });
      expect(fresh.statusCode, fresh.payload).toBe(200);
      expect(fresh.headers['cache-control']).toBe('private, no-store');
      expect(
        workflowConcurrencySettingsSchema.parse(fresh.json()),
      ).toMatchObject({
        limit: null,
        revision: 1,
        workspaceActiveRunLimit: 5,
        workspacePolicyState: 'active',
        overflow: 'queue',
      });
      const noOp = await api.send('PUT', route, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { limit: null, expectedRevision: 1 },
      });
      expect(noOp.statusCode, noOp.payload).toBe(200);
      expect(noOp.json()).toMatchObject({
        settings: { limit: null, revision: 1 },
        replayed: false,
      });
      const exceeded = await api.send('PUT', route, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { limit: 6, expectedRevision: 1 },
      });
      expectProblem(exceeded, 409, 'workflow.concurrency_limit_exceeded');
      expect(
        workflowConcurrencyLimitExceededProblemSchema.parse(exceeded.json())
          .maximum,
      ).toBe(5);
      const headers = { 'idempotency-key': randomUUID() };
      const payload = { limit: 1, expectedRevision: 1 };
      const accepted = await api.send('PUT', route, {
        browser: owner,
        headers,
        payload,
      });
      expect(accepted.statusCode, accepted.payload).toBe(200);
      expect(accepted.headers['cache-control']).toBe('private, no-store');
      const first = accepted.json<WorkflowConcurrencyCommandResponse>();
      expect(first).toMatchObject({
        settings: { limit: 1, revision: 2 },
        replayed: false,
      });
      const conflict = await api.send('PUT', route, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload,
      });
      expectProblem(conflict, 409, 'workflow.concurrency_revision_conflict');
      expect(
        workflowConcurrencyRevisionConflictProblemSchema.parse(conflict.json())
          .currentRevision,
      ).toBe(2);
      await api
        .database()
        .query(
          'delete from app.workspace_execution_entitlements where workspace_id=$1',
          [workspaceId],
        );
      const unavailable = await api.send('PUT', route, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { limit: 2, expectedRevision: 2 },
      });
      expectProblem(unavailable, 409, 'workflow.concurrency_limit_unavailable');
      const removed = await api.send('PUT', route, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { limit: null, expectedRevision: 2 },
      });
      expect(removed.statusCode, removed.payload).toBe(200);
      expect(removed.json()).toMatchObject({
        settings: {
          limit: null,
          revision: 3,
          workspacePolicyState: 'unavailable',
          workspaceActiveRunLimit: null,
        },
      });
      const replay = await api.send('PUT', route, {
        browser: owner,
        headers,
        payload,
      });
      expect(replay.statusCode, replay.payload).toBe(200);
      expect(replay.json()).toEqual({ ...first, replayed: true });
      expectProblem(
        await api.send('PUT', route, {
          browser: owner,
          headers,
          payload: { limit: null, expectedRevision: 3 },
        }),
        409,
        'request.idempotency_conflict',
      );
      const audit = await api
        .database()
        .query<{ count: string }>(
          `select count(*)::text count from app.audit_events where target_id=$1 and action='workflow.concurrency_settings_changed'`,
          [workflowId],
        );
      expect(audit.rows[0]?.count).toBe('2');
    });
    it('enforces reader/edit capabilities, foreign workflow and inactive workspace nondisclosure', async () => {
      const { email, owner, workspaceId, route } = await fixture();
      for (const role of ['builder', 'operator', 'viewer'] as const) {
        const memberEmail = `${randomUUID()}@example.test`;
        await api.signUp(memberEmail, '/login?verified=true');
        const member = await api.signIn(memberEmail);
        const userId = (
          await api.send('GET', '/v1/users/me', { browser: member })
        ).json<{ id: string }>().id;
        await api
          .database()
          .query(
            `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')`,
            [workspaceId, userId, role],
          );
        expect(
          (await api.send('GET', route, { browser: member })).statusCode,
        ).toBe(200);
        const updated = await api.send('PUT', route, {
          browser: member,
          headers: { 'idempotency-key': randomUUID() },
          payload: { limit: null, expectedRevision: 1 },
        });
        if (role === 'builder')
          expect(updated.statusCode, updated.payload).toBe(200);
        else expectProblem(updated, 404, 'resource.not_found');
      }
      expectProblem(
        await api.send(
          'GET',
          `/v1/workspaces/${workspaceId}/workflows/${randomUUID()}/concurrency`,
          { browser: owner },
        ),
        404,
        'resource.not_found',
      );
      await api
        .database()
        .query(`update app.workspaces set status='suspended' where id=$1`, [
          workspaceId,
        ]);
      const current = await api.signIn(email);
      expectProblem(
        await api.send('GET', route, { browser: current }),
        404,
        'resource.not_found',
      );
    });
  },
);
