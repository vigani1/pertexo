import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
  type Browser,
} from '../support/better-auth/real-api.support.js';
import { seedWorld, type World } from './suspended/world.js';

// The same request succeeds before and after repairing each damaged server row.
describe.runIf(betterAuthIntegrationEnabled)(
  'stored task failures through real HTTP',
  () => {
    const api = useBetterAuthRealApi('stored_task_errors', {
      automationTokens: true,
      notifications: true,
      connections: {
        config: {
          mode: 'self-managed',
          encryption: {
            current: {
              version: 'fixture-v1',
              key: Buffer.alloc(32, 77).toString('base64'),
            },
            previous: [],
          },
        },
      },
    });
    let world: World, browser: Browser;
    beforeAll(async () => {
      world = await seedWorld(api);
      browser = await api.signIn(world.ownerEmail);
    });

    it.each([
      ['config', { title: 42, private: 'stored-only-canary' }],
      ['context', { details: 'stored-only-canary' }],
      [
        'output_ref',
        { kind: 'inline', value: { decision: 'stored-only-canary' } },
      ],
    ] as const)(
      'reports damaged stored task %s as a server failure without blaming or exposing the input',
      async (column, damaged) => {
        const url = `/v1/workspaces/${world.workspaceId}/pending-tasks/${world.taskId}`;
        expect((await api.send('GET', url, { browser })).statusCode).toBe(200);
        const before = (
          await api
            .database()
            .query<Record<string, unknown>>(
              'select config,context,output_ref,status,completed_at,decided_by from app.pending_run_tasks where id=$1',
              [world.taskId],
            )
        ).rows[0];
        if (before === undefined) throw new Error('Task missing');
        try {
          if (column === 'output_ref')
            await api
              .database()
              .query<Record<string, unknown>>(
                "update app.pending_run_tasks set status='approved',completed_at=clock_timestamp(),decided_by=(select created_by from app.workspaces where id=$2),output_ref=$3::jsonb where id=$1",
                [world.taskId, world.workspaceId, JSON.stringify(damaged)],
              );
          else
            await api
              .database()
              .query<Record<string, unknown>>(
                `update app.pending_run_tasks set ${column}=$2::jsonb where id=$1`,
                [world.taskId, JSON.stringify(damaged)],
              );
          const failed = await api.send('GET', url, { browser });
          expectProblem(failed, 500, 'internal.unexpected');
          expect(failed.json()).not.toHaveProperty('errors');
          expect(failed.payload).not.toContain('stored-only-canary');
        } finally {
          await api
            .database()
            .query<Record<string, unknown>>(
              'update app.pending_run_tasks set config=$2,context=$3,output_ref=$4,status=$5,completed_at=$6,decided_by=$7 where id=$1',
              [
                world.taskId,
                before.config,
                before.context,
                before.output_ref,
                before.status,
                before.completed_at,
                before.decided_by,
              ],
            );
        }
        expect((await api.send('GET', url, { browser })).statusCode).toBe(200);
      },
    );

    it('reports damaged current-attempt diagnostics as a server failure', async () => {
      const [node] = (
        await api
          .database()
          .query<{ node_run_id: string }>(
            'select node_run_id from app.pending_run_tasks where id=$1',
            [world.taskId],
          )
      ).rows;
      if (node === undefined) throw new Error('Node missing');
      const attemptId = randomUUID();
      await api.database().query(
        `insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,code_diagnostics,completed_at)
        values($1,$2,$3,1,'failed','safe','{"private":"stored-only-canary"}',clock_timestamp())`,
        [attemptId, world.workspaceId, node.node_run_id],
      );
      await api
        .database()
        .query(
          'update app.node_runs set current_attempt_id=$2,current_attempt_number=1 where id=$1',
          [node.node_run_id, attemptId],
        );
      const response = await api.send(
        'GET',
        `/v1/workspaces/${world.workspaceId}/runs/${world.runId}/node-runs/${node.node_run_id}/diagnostics`,
        { browser },
      );
      expectProblem(response, 500, 'internal.unexpected');
      expect(response.payload).not.toContain('stored-only-canary');
      expect(response.json()).not.toHaveProperty('errors');
    });

    it('reports a damaged saved public form definition as a server failure', async () => {
      const url = `/v1/forms/${world.formPublicId}`;
      const headers = { 'x-pertexo-form-key': world.formCapability };
      expect((await api.send('GET', url, { headers })).statusCode).toBe(200);
      const before = (
        await api
          .database()
          .query<{ graph_json: unknown }>(
            'select graph_json from app.workflow_versions where id=$1',
            [world.formVersionId],
          )
      ).rows[0];
      if (before === undefined) throw new Error('Form version missing');
      try {
        await api
          .database()
          .query('update app.workflow_versions set graph_json=$2 where id=$1', [
            world.formVersionId,
            JSON.stringify({ private: 'stored-only-canary' }),
          ]);
        const response = await api.send('GET', url, { headers });
        expectProblem(response, 500, 'internal.unexpected');
        expect(response.payload).not.toContain('stored-only-canary');
        expect(response.json()).not.toHaveProperty('errors');
      } finally {
        await api
          .database()
          .query('update app.workflow_versions set graph_json=$2 where id=$1', [
            world.formVersionId,
            JSON.stringify(before.graph_json),
          ]);
      }
    });

    it('retains a 400 for an invalid caller task query', async () => {
      expectProblem(
        await api.send(
          'GET',
          `/v1/workspaces/${world.workspaceId}/pending-tasks?limit=not-a-number`,
          { browser },
        ),
        400,
        'request.invalid',
      );
    });
  },
);
