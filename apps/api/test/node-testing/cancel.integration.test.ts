import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
  type Browser,
} from '../support/better-auth/real-api.support.js';
import { emptyWorkflowGraph } from '../workspaces/real-api/graphs.js';

const headers = () => ({ 'idempotency-key': randomUUID() });

/**
 * Over real HTTP, because the rule spans two layers: the API's guards let a
 * tester through and core decides who may stop what.
 */
describe.skipIf(!betterAuthIntegrationEnabled)(
  'stopping a test over HTTP',
  () => {
    const api = useBetterAuthRealApi('test_cancel');
    let owner: Browser;
    let otherBuilder: Browser;
    let root: string;
    let draft: string;

    async function join(role: string): Promise<Browser> {
      const email = `${role}-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      return api.signIn(email).then(async (browser) => {
        await api.database().query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status)
         select $1,id,$2,'active' from app.users where email=$3`,
          [root.split('/').at(-1), role, email],
        );
        return browser;
      });
    }

    beforeAll(async () => {
      const email = `owner-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      owner = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        headers: headers(),
        payload: {
          name: 'Stopping tests',
          slug: `stopping-${randomUUID().slice(0, 12)}`,
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      root = `/v1/workspaces/${workspace.json<{ id: string }>().id}`;
      const made = await api.send('POST', `${root}/workflows`, {
        browser: owner,
        headers: headers(),
        payload: { name: 'Stopped' },
      });
      expect(made.statusCode, made.payload).toBe(201);
      const workflowId = made.json<{ workflow: { id: string } }>().workflow.id;
      const saved = await api.send(
        'PUT',
        `${root}/workflows/${workflowId}/draft`,
        {
          browser: owner,
          headers: { ...headers(), 'if-match': String(made.headers.etag) },
          payload: { graph: emptyWorkflowGraph() },
        },
      );
      expect(saved.statusCode, saved.payload).toBe(200);
      const published = await api.send(
        'POST',
        `${root}/workflows/${workflowId}/publish`,
        {
          browser: owner,
          headers: { ...headers(), 'if-match': String(saved.headers.etag) },
        },
      );
      expect(published.statusCode, published.payload).toBe(200);
      draft = `${root}/workflows/${workflowId}/draft`;
      otherBuilder = await join('builder');
    }, 60_000);

    async function startTest(browser: Browser): Promise<string> {
      const prepared = await api.send('GET', `${draft}/tests/prepare`, {
        browser,
      });
      expect(prepared.statusCode, prepared.payload).toBe(200);
      const preparation = prepared.json<{
        draftRevision: number;
        samples: unknown[];
        effectfulSteps: { nodeId: string }[];
      }>();
      const started = await api.send('POST', `${draft}/tests`, {
        browser,
        headers: headers(),
        payload: {
          expectedRevision: preparation.draftRevision,
          expectedSamples: preparation.samples,
          expectedEffectfulSteps: preparation.effectfulSteps.map(
            (step) => step.nodeId,
          ),
          input: { note: 'stopping' },
          acknowledgeSideEffects: false,
        },
      });
      expect(started.statusCode, started.payload).toBeLessThan(300);
      return started.json<{ runId: string }>().runId;
    }

    const cancelTest = (browser: Browser, runId: string) =>
      api.send('POST', `${draft}/tests/${runId}/cancel`, {
        browser,
        headers: headers(),
        payload: {},
      });

    it('lets the builder who started a test stop it', async () => {
      const starter = await join('builder');
      const runId = await startTest(starter);
      const stopped = await cancelTest(starter, runId);
      expect(stopped.statusCode, stopped.payload).toBe(200);
      expect(stopped.json()).toEqual({ canceled: true });
    });

    it("answers another builder's stop with 'not found', and the test keeps running", async () => {
      const starter = await join('builder');
      const runId = await startTest(starter);
      const refused = await cancelTest(otherBuilder, runId);
      expect(refused.statusCode, refused.payload).toBe(404);
      expect(refused.json()).toMatchObject({ code: 'resource.not_found' });
      const { rows } = await api
        .database()
        .query<{ cancel_requested_at: Date | null }>(
          'select cancel_requested_at from app.workflow_runs where id=$1',
          [runId],
        );
      expect(rows[0]?.cancel_requested_at).toBeNull();
      await expect(cancelTest(starter, runId)).resolves.toMatchObject({
        statusCode: 200,
      });
    });

    it("still lets the owner stop a builder's test", async () => {
      const runId = await startTest(await join('builder'));
      await expect(cancelTest(owner, runId)).resolves.toMatchObject({
        statusCode: 200,
      });
    });

    it('keeps a real run closed to a builder, even one they started', async () => {
      const starter = await join('builder');
      const workflowId = draft.split('/').at(-2);
      const started = await api.send(
        'POST',
        `${root}/workflows/${String(workflowId)}/runs`,
        {
          browser: starter,
          headers: headers(),
          payload: { input: { note: 'real' } },
        },
      );
      expect(started.statusCode, started.payload).toBeLessThan(300);
      const runId = started.json<{ run: { id: string } }>().run.id;
      const refused = await api.send('POST', `${root}/runs/${runId}/cancel`, {
        browser: starter,
        headers: headers(),
        payload: {},
      });
      expect(refused.statusCode, refused.payload).toBe(404);
      const { rows } = await api
        .database()
        .query<{ cancel_requested_at: Date | null }>(
          'select cancel_requested_at from app.workflow_runs where id=$1',
          [runId],
        );
      expect(rows[0]?.cancel_requested_at).toBeNull();
    });
  },
);
