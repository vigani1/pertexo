import { randomUUID } from 'node:crypto';

import {
  apiTokenCreateResponseSchema,
  workflowPublishResponseSchema,
  workflowRunStartResponseSchema,
} from '@pertexo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import { createAutomationApiFixture } from './api/api-token-api.fixture.js';
import { createTokenWorkspace } from './api/portability/setup.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'reading a run’s data with an API token',
  () => {
    const caseFixture = createAutomationApiFixture();
    const { api } = caseFixture;
    let world: Awaited<ReturnType<typeof createTokenWorkspace>>;
    let runId: string;
    let nodeRunId: string;
    let runRoot: string;

    const STEP_INPUT = { asked: 'for the invoice' };
    const STEP_OUTPUT = { answered: 'with the invoice' };

    const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

    const tokenWith = async (
      browser: typeof world.browser,
      scopes: readonly string[],
    ) => {
      const reply = await api.send('POST', `${world.base}/api-tokens`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: `Scopes ${randomUUID().slice(0, 8)}`, scopes },
      });
      expect(reply.statusCode, reply.payload).toBe(201);
      const created = apiTokenCreateResponseSchema.parse(reply.json());
      if (created.replayed) throw new Error('First creation replayed');
      return bearer(created.secret);
    };

    const dataPaths = () => [
      `${runRoot}/input`,
      `${runRoot}/node-runs/${nodeRunId}/input`,
      `${runRoot}/node-runs/${nodeRunId}/output`,
    ];

    beforeAll(async () => {
      world = await createTokenWorkspace(caseFixture);
      const published = await api.send(
        'POST',
        `${world.base}/workflows/${world.workflowId}/publish`,
        {
          headers: {
            ...world.headers,
            'idempotency-key': randomUUID(),
            'if-match': String(world.saved.headers.etag),
          },
        },
      );
      expect(published.statusCode, published.payload).toBe(200);
      const versionId = workflowPublishResponseSchema.parse(published.json())
        .version.id;
      const start = await api.send(
        'POST',
        `${world.base}/workflows/${world.workflowId}/runs`,
        {
          headers: { ...world.headers, 'idempotency-key': randomUUID() },
          payload: {
            input: { value: 'what the script sent' },
            expectedPublishedVersionId: versionId,
          },
        },
      );
      expect(start.statusCode, start.payload).toBe(202);
      runId = workflowRunStartResponseSchema.parse(start.json()).run.id;
      runRoot = `${world.base}/runs/${runId}`;

      // A worker isn't part of this: a step of the run, as one would have left it.
      nodeRunId = randomUUID();
      await api.database().query(
        `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,
           status,side_effect_class,input_ref,output_ref,completed_at)
         values($1,$2,$3,'step','step','succeeded','safe',$4::jsonb,$5::jsonb,clock_timestamp())`,
        [
          nodeRunId,
          world.workspaceId,
          runId,
          JSON.stringify({ kind: 'inline', value: STEP_INPUT }),
          JSON.stringify({ kind: 'inline', value: STEP_OUTPUT }),
        ],
      );
    }, 120_000);

    it('opens the run’s input and each step’s input and output under its own scope', async () => {
      const headers = await tokenWith(world.browser, ['run:read-data']);

      const input = await api.send('GET', `${runRoot}/input`, { headers });
      expect(input.statusCode, input.payload).toBe(200);
      expect(input.json()).toEqual({
        input: { kind: 'inline', value: { value: 'what the script sent' } },
      });
      const stepInput = await api.send(
        'GET',
        `${runRoot}/node-runs/${nodeRunId}/input`,
        { headers },
      );
      expect(stepInput.statusCode, stepInput.payload).toBe(200);
      expect(stepInput.json()).toEqual({
        input: { kind: 'inline', value: STEP_INPUT },
      });
      const stepOutput = await api.send(
        'GET',
        `${runRoot}/node-runs/${nodeRunId}/output`,
        { headers },
      );
      expect(stepOutput.statusCode, stepOutput.payload).toBe(200);
      expect(stepOutput.json()).toEqual({
        output: { kind: 'inline', value: STEP_OUTPUT },
      });
    });

    // Outputs can hold sensitive data, so a token that can see runs exist can't read
    // them. Saying which scope is missing gives nothing away: this token can already
    // open the run, and the check runs before any run is looked up.
    it('stays shut to a token with only run:read, which still sees the run', async () => {
      const headers = await tokenWith(world.browser, ['run:read']);

      expect((await api.send('GET', runRoot, { headers })).statusCode).toBe(
        200,
      );
      for (const path of dataPaths()) {
        const reply = await api.send('GET', path, { headers });
        expect(reply.statusCode, path).toBe(403);
        expect(reply.json<{ code: string }>().code).toBe(
          'auth.token_scope_required',
        );
        expect(reply.payload).toContain('run:read-data');
        expect(reply.payload).not.toContain('what the script sent');
        expect(reply.payload).not.toContain('invoice');
      }
    });

    it('doesn’t open the rest of the run to a token with only run:read-data', async () => {
      const headers = await tokenWith(world.browser, ['run:read-data']);

      const reply = await api.send('GET', runRoot, { headers });
      expect(reply.statusCode).toBe(403);
      expect(reply.json<{ code: string }>().code).toBe(
        'auth.token_scope_required',
      );
      expect(reply.payload).not.toContain('what the script sent');
      expect(reply.payload).not.toContain('invoice');
    });

    it('answers a missing scope the same for a run that exists and one that doesn’t', async () => {
      const headers = await tokenWith(world.browser, ['run:read-data']);

      const real = await api.send('GET', runRoot, { headers });
      const invented = await api.send(
        'GET',
        `${world.base}/runs/${randomUUID()}`,
        { headers },
      );
      const fields = (reply: typeof real) => {
        const {
          instance: _instance,
          requestId: _requestId,
          ...rest
        } = reply.json<Record<string, unknown>>();
        return { status: reply.statusCode, ...rest };
      };
      expect(fields(invented)).toEqual(fields(real));
    });

    // The token names its own workspace, so whatever its scopes, another one reads as
    // missing: a 403 here would confirm that workspace, or what's in it.
    it('reads as missing in another workspace, whatever scopes the token has', async () => {
      const other = await api.send('POST', '/v1/workspaces', {
        browser: world.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Another workspace',
          slug: `other-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(other.statusCode, other.payload).toBe(201);
      const elsewhere = `/v1/workspaces/${other.json<{ id: string }>().id}`;
      const invented = `/v1/workspaces/${randomUUID()}`;

      for (const scopes of [
        ['run:read'],
        ['run:read-data'],
        ['run:read', 'run:read-data', 'workflow:read', 'run:start'],
      ]) {
        const headers = await tokenWith(world.browser, scopes);
        for (const workspace of [elsewhere, invented])
          for (const path of [
            `${workspace}/runs/${runId}`,
            `${workspace}/runs/${runId}/input`,
            `${workspace}/workflows`,
          ]) {
            const reply = await api.send('GET', path, { headers });
            expect(reply.statusCode, `${scopes.join()} ${path}`).toBe(404);
            expect(reply.json<{ code: string }>().code).toBe(
              'resource.not_found',
            );
          }
        const writing = await api.send(
          'POST',
          `${elsewhere}/workflows/${world.workflowId}/runs`,
          { headers: { ...headers, 'idempotency-key': randomUUID() } },
        );
        expect(writing.statusCode, scopes.join()).toBe(404);
      }
    });

    it('tells a token about itself, and tells nobody else', async () => {
      const issued = await api.send('POST', `${world.base}/api-tokens`, {
        browser: world.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Who am I', scopes: ['run:read'] },
      });
      const created = apiTokenCreateResponseSchema.parse(issued.json());
      if (created.replayed) throw new Error('First creation replayed');

      const own = await api.send('GET', '/v1/token', {
        headers: bearer(created.secret),
      });
      expect(own.statusCode, own.payload).toBe(200);
      expect(own.json()).toEqual({
        id: created.token.id,
        workspaceId: world.workspaceId,
        name: 'Who am I',
        scopes: ['run:read'],
        expiresAt: created.token.expiresAt,
      });
      expect(own.payload).not.toContain(created.secret);

      const session = await api.send('GET', '/v1/token', {
        browser: world.browser,
      });
      expect(session.statusCode).toBe(401);

      // This suite shares one owner's active token limit.
      const revoked = await api.send(
        'POST',
        `${world.base}/api-tokens/${created.token.id}/revoke`,
        {
          browser: world.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {},
        },
      );
      expect(revoked.statusCode, revoked.payload).toBe(200);
    });

    it('asks for credentials with none, or with a revoked or made-up token', async () => {
      for (const path of dataPaths())
        expect((await api.send('GET', path, {})).statusCode, path).toBe(401);
      const madeUp = await api.send('GET', dataPaths()[0] ?? '', {
        headers: bearer(
          `ptx_1.${randomUUID()}.${randomUUID()}.${'A'.repeat(43)}`,
        ),
      });
      expect(madeUp.statusCode).toBe(401);
    });

    it('reads as missing for a run that isn’t in the token’s workspace', async () => {
      const headers = await tokenWith(world.browser, ['run:read-data']);
      const elsewhere = randomUUID();

      for (const path of [
        `${world.base}/runs/${elsewhere}/input`,
        `${world.base}/runs/${elsewhere}/node-runs/${nodeRunId}/output`,
        `${runRoot}/node-runs/${randomUUID()}/output`,
      ])
        expect(
          (await api.send('GET', path, { headers })).statusCode,
          path,
        ).toBe(404);
    });

    it('can be issued by a viewer, whose role has always read this', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const { rows } = await api
        .database()
        .query<{ id: string }>('select id from app.users where email=$1', [
          email,
        ]);
      await api.database().query(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
           values($1,$2,'viewer','active')`,
        [world.workspaceId, rows[0]?.id],
      );
      const viewer = await api.signIn(email);

      const headers = await tokenWith(viewer, ['run:read-data']);

      const input = await api.send('GET', `${runRoot}/input`, { headers });
      expect(input.statusCode, input.payload).toBe(200);
      expect(input.payload).toContain('what the script sent');
    });

    // The API's list isn't the only thing between a scope and a stored token.
    it('is the last scope the database’s check lets in', async () => {
      const allowed = await api
        .database()
        .query<{ id: string }>(
          `select id from app.api_tokens where workspace_id=$1 and scopes ? 'run:read-data' limit 1`,
          [world.workspaceId],
        );
      const id = allowed.rows[0]?.id;
      expect(id).toBeDefined();

      await expect(
        api
          .database()
          .query(
            `update app.api_tokens set scopes='["run:read-everything"]'::jsonb where id=$1`,
            [id],
          ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'api_tokens_scopes_valid',
      });
    });

    it('refuses a scope the API doesn’t know', async () => {
      const reply = await api.send('POST', `${world.base}/api-tokens`, {
        browser: world.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Unknown', scopes: ['run:read-everything'] },
      });
      expect(reply.statusCode).toBe(400);
    });

    // A route that needs a body still says so when one is left out behind a JSON header.
    it('answers a replay with a JSON header and no body from its own schema', async () => {
      const reply = await api.send('POST', `${runRoot}/replay`, {
        browser: world.browser,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
      });
      expect(reply.statusCode, reply.payload).toBe(400);
    });

    it('starts and cancels on a real route with a JSON header and no body', async () => {
      const headers = {
        ...world.headers,
        'content-type': 'application/json',
      };
      const started = await api.send(
        'POST',
        `${world.base}/workflows/${world.workflowId}/runs`,
        { headers: { ...headers, 'idempotency-key': randomUUID() } },
      );
      expect(started.statusCode, started.payload).toBe(202);
      const id = workflowRunStartResponseSchema.parse(started.json()).run.id;

      const canceled = await api.send(
        'POST',
        `${world.base}/runs/${id}/cancel`,
        { headers },
      );
      expect(canceled.statusCode, canceled.payload).toBe(200);
    });
  },
);
