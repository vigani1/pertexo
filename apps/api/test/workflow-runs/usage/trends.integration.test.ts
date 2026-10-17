import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { usageTrendsResponseSchema } from '@pertexo/contracts';
import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'authenticated retained trends',
  () => {
    const api = useBetterAuthRealApi('usage-trends');
    it('serves bounded ordinary summaries with private caching and denies outsiders', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const owner = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Trend proof',
          slug: `trends-${randomUUID().slice(0, 8)}`,
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
          payload: { name: 'Orders' },
        },
      );
      expect(workflow.statusCode, workflow.payload).toBe(201);
      const workflowId = workflow.json<{ workflow: { id: string } }>().workflow
        .id;
      const route = `/v1/workspaces/${workspaceId}/usage-trends`;
      expectProblem(await api.send('GET', route), 401, 'auth.unauthenticated');
      expectProblem(
        await api.send('GET', `${route}?period=7d`, { browser: owner }),
        400,
        'request.invalid',
      );
      const seed = await api.database().connect();
      try {
        await seed.query('begin');
        await seed.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        for (const [kind, status, age, seconds] of [
          ['manual', 'succeeded', '1 hour', 20],
          ['manual', 'failed', '45 days', 40],
          ['test', 'succeeded', '1 hour', 1000],
        ] as const)
          await seed.query(
            `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at,started_at,completed_at)
         values($1,$2,$3,$4,$5,$6,statement_timestamp()-$7::interval,statement_timestamp()-$7::interval,statement_timestamp()-$7::interval+make_interval(secs=>$8::double precision))`,
            [
              randomUUID(),
              workspaceId,
              workflowId,
              randomUUID(),
              kind,
              status,
              age,
              seconds,
            ],
          );
        await seed.query('commit');
      } catch (error: unknown) {
        await seed.query('rollback');
        throw error;
      } finally {
        seed.release();
      }
      const recent = await api.send('GET', route, { browser: owner });
      expect(recent.statusCode, recent.payload).toBe(200);
      expect(recent.headers['cache-control']).toBe('private, no-store');
      expect(usageTrendsResponseSchema.parse(recent.json())).toMatchObject({
        period: '30d',
        total: 1,
        elapsed: { measuredRuns: 1, averageMs: 20000 },
        busiest: [{ workflowId, workflowName: 'Orders', runs: 1 }],
        mostFailures: [],
      });
      const longer = await api.send('GET', `${route}?period=90d`, {
        browser: owner,
      });
      expect(longer.statusCode, longer.payload).toBe(200);
      const summary = usageTrendsResponseSchema.parse(longer.json());
      expect(summary.days).toHaveLength(90);
      expect(summary).toMatchObject({
        total: 2,
        elapsed: { measuredRuns: 2, averageMs: 30000, slowestMs: 40000 },
        mostFailures: [{ workflowId, workflowName: 'Orders', failures: 1 }],
      });
      const foreignEmail = `${randomUUID()}@example.test`;
      await api.signUp(foreignEmail, '/login?verified=true');
      const outsider = await api.signIn(foreignEmail);
      expectProblem(
        await api.send('GET', route, { browser: outsider }),
        404,
        'resource.not_found',
      );
      await api
        .database()
        .query("update app.workspaces set status='suspended' where id=$1", [
          workspaceId,
        ]);
      const currentOwner = await api.signIn(email);
      const retained = await api.send('GET', `${route}?period=90d`, {
        browser: currentOwner,
      });
      expect(retained.statusCode, retained.payload).toBe(200);
      expect(usageTrendsResponseSchema.parse(retained.json()).total).toBe(2);
    });
  },
);
