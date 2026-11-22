import { connectionResponseSchema } from '@pertexo/contracts';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectionEnvelopeEncryption,
  parseAllowedPrivateNetworks,
  type ConnectionSecretContext,
} from '@pertexo/secrets/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createNodeProviderHttpClient } from '../../../src/platform/connections/http-client.js';
import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
  type Browser,
} from '../../support/better-auth/real-api.support.js';

const credentialSentinel = 'credential-storage-sentinel';
const settingsSentinel = 'masked-step-settings-sentinel';
const payloadSentinel = 'run-payload-sentinel';

describe.runIf(betterAuthIntegrationEnabled)('failed run explanation', () => {
  const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
    randomBytes(32),
    'connection',
  );
  const transport = createNodeProviderHttpClient({
    allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
  });
  const api = useBetterAuthRealApi('failed_run_explanation', {
    connections: {
      config: { kmsKeyReference: 'local-inference', region: 'us-east-1' },
      services: () => ({
        encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
        http: transport,
      }),
    },
  });
  const requests: string[] = [];
  const timedRequest = Promise.withResolvers<undefined>();
  let mode: 'answer' | 'large' | 'timeout' = 'answer';
  const inference = createServer((request, response) => {
    request.setEncoding('utf8');
    let body = '';
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(body);
      if (request.headers.authorization !== `Bearer ${credentialSentinel}`) {
        response.writeHead(401).end();
        return;
      }
      if (mode === 'timeout') {
        timedRequest.resolve(undefined);
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  explanation:
                    mode === 'large'
                      ? 'x'.repeat(256 * 1024)
                      : 'The model refused to answer.',
                  stepIds: ['extract', 'unrelated'],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 10 },
        }),
      );
    });
  });

  let owner: Browser;
  let member: Browser;
  let outsider: Browser;
  let path: string;
  let workspaceId: string;
  let runId: string;
  let confirmation: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      inference.listen(0, '127.0.0.1', resolve);
    });
    const { browser, id: ownerId } = await newUser();
    owner = browser;
    const collaborator = await newUser();
    member = collaborator.browser;
    outsider = (await newUser()).browser;
    workspaceId = await createWorkspace(owner);
    await addBuilder(workspaceId, collaborator.id);
    runId = await seedFailedRun(workspaceId, ownerId);
    const workspacePath = `/v1/workspaces/${workspaceId}`;
    path = `${workspacePath}/runs/${runId}/explanation`;
    const disabled = await api.send('GET', path, { browser: owner });
    expect(disabled.statusCode, disabled.payload).toBe(200);
    expect(disabled.json()).toEqual({ kind: 'not_configured' });
    const address = inference.address();
    if (address === null || typeof address === 'string')
      throw new Error('Inference listener is unavailable');
    const connection = await api.send('POST', `${workspacePath}/connections`, {
      browser: owner,
      headers: { 'Idempotency-Key': randomUUID() },
      payload: {
        providerKey: 'ai',
        name: 'Local inference',
        credential: {
          type: 'model_api_key',
          endpoint: 'vllm',
          baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
          apiKey: credentialSentinel,
        },
      },
    });
    expect(connection.statusCode, connection.payload).toBe(201);
    const connectionId = connectionResponseSchema.parse(connection.json()).id;
    await api
      .database()
      .query(
        "update app.connections set access_mode='restricted' where workspace_id=$1 and id=$2",
        [workspaceId, connectionId],
      );
    const setting = await api.send('PUT', `${workspacePath}/assistant`, {
      browser: owner,
      payload: { selection: { connectionId, model: 'local-test' } },
    });
    expect(setting.statusCode, setting.payload).toBe(200);
    expect(setting.json()).toMatchObject({ kind: 'saved' });
    const disclosure = await api.send('GET', path, { browser: owner });
    expect(disclosure.statusCode, disclosure.payload).toBe(200);
    expect(disclosure.json()).toMatchObject({
      kind: 'ready',
      connectionName: 'Local inference',
      host: `127.0.0.1:${String(address.port)}`,
    });
    confirmation = disclosure.json<{ confirmation: string }>().confirmation;
  });

  afterAll(async () => {
    keys.close();
    inference.closeAllConnections();
    await new Promise<void>((resolve) => {
      inference.close(() => {
        resolve();
      });
    });
  });

  it('refuses users who cannot read the run or use its selected connection', async () => {
    const count = requests.length;
    expect(
      (await api.send('GET', path, { browser: outsider })).statusCode,
    ).toBe(404);
    const read = await api.send('GET', path.replace(/\/explanation$/u, ''), {
      browser: member,
    });
    expect(read.statusCode, read.payload).toBe(200);
    expect((await api.send('GET', path, { browser: member })).statusCode).toBe(
      404,
    );
    expect((await explain(member)).statusCode).toBe(404);
    expect(requests).toHaveLength(count);
  });

  it('sends only safe facts, keeps authorized references and records bounded usage', async () => {
    const result = await explain(owner);
    expect(result.statusCode, result.payload).toBe(200);
    expect(result.json()).toMatchObject({
      kind: 'explained',
      steps: [{ id: 'extract', label: 'Extract an order' }],
      usage: {
        kind: 'complete',
        model: 'local-test',
        inputTokens: 40,
        outputTokens: 10,
      },
    });
    const body = requests.at(-1);
    expect(body).toContain('model.output_refused');
    expect(body).toContain('Extract an order');
    const retained = await api.database().query<{ metadata: unknown }>(
      `select metadata from app.usage_events
       where workspace_id=$1 and resource_id=$2 and category='assistant.model'`,
      [workspaceId, runId],
    );
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]?.metadata).toMatchObject({
      kind: 'complete',
      model: 'local-test',
      inputTokens: 40,
      outputTokens: 10,
      purpose: 'explain_run',
    });
    for (const sentinel of [
      credentialSentinel,
      settingsSentinel,
      payloadSentinel,
    ]) {
      expect(body).not.toContain(sentinel);
      expect(JSON.stringify(retained.rows)).not.toContain(sentinel);
      expect(result.payload).not.toContain(sentinel);
    }
  });

  it('reports provider failures and releases database transactions while inference waits', async () => {
    mode = 'large';
    const large = await explain(owner);
    expect(large.statusCode, large.payload).toBe(200);
    expect(large.json()).toMatchObject({
      kind: 'response_too_large',
      usage: { kind: 'incomplete' },
    });

    mode = 'timeout';
    const timed = explain(owner);
    await timedRequest.promise;
    const activity = await api.database().query(
      `select pid from pg_stat_activity
       where datname = current_database() and usename = 'pertexo_app'
       and state = 'idle in transaction'`,
    );
    const result = await timed;
    expect(activity.rows).toEqual([]);
    expect(result.statusCode, result.payload).toBe(200);
    expect(result.json()).toMatchObject({
      kind: 'timeout',
      usage: { kind: 'incomplete' },
    });
    const retained = await api.database().query<{ kind: string }>(
      `select metadata->>'kind' kind from app.usage_events
       where workspace_id=$1 and resource_id=$2 and category='assistant.model'`,
      [workspaceId, runId],
    );
    expect(
      retained.rows.filter(({ kind }) => kind === 'incomplete'),
    ).toHaveLength(2);
  }, 25_000);

  it('refuses the 21st explanation request in one workspace across actors', async () => {
    const first = await newUser();
    const second = await newUser();
    const third = await newUser();
    const workspace = await createWorkspace(first.browser);
    await addBuilder(workspace, second.id);
    await addBuilder(workspace, third.id);
    const run = await seedFailedRun(workspace, first.id);
    const explanationPath = `/v1/workspaces/${workspace}/runs/${run}/explanation`;
    const request = (browser: Browser) =>
      api.send('POST', explanationPath, { browser, payload: { confirmation } });

    for (const { browser } of [first, second]) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const accepted = await request(browser);
        expect(accepted.statusCode, accepted.payload).toBe(200);
        expect(accepted.json()).toEqual({ kind: 'not_configured' });
      }
    }

    expectProblem(await request(third.browser), 429, 'request.rate_limited');
  });

  async function createWorkspace(browser: Browser) {
    const workspace = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'Idempotency-Key': randomUUID() },
      payload: {
        name: 'Run diagnostics',
        slug: `diagnostics-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(workspace.statusCode, workspace.payload).toBe(201);
    return workspace.json<{ id: string }>().id;
  }

  async function addBuilder(workspaceId: string, userId: string) {
    await api
      .database()
      .query(
        "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'builder')",
        [workspaceId, userId],
      );
  }

  function explain(browser: Browser) {
    return api.send('POST', path, { browser, payload: { confirmation } });
  }

  async function newUser() {
    const email = `explanation-${randomUUID()}@example.test`;
    await api.signUp(email, '/workspaces');
    const browser = await api.signIn(email);
    const person = await api.send('GET', '/v1/users/me', { browser });
    expect(person.statusCode, person.payload).toBe(200);
    return { browser, id: person.json<{ id: string }>().id };
  }

  async function seedFailedRun(workspace: string, actor: string) {
    const workflow = randomUUID();
    const version = randomUUID();
    const run = randomUUID();
    const db = await api.database().connect();
    try {
      await db.query('begin');
      await db.query("select set_config('app.workspace_id',$1,true)", [
        workspace,
      ]);
      await db.query(
        `insert into app.workflows (id,workspace_id,name,lifecycle_status,activation_status,created_by)
       values($1,$2,'Faulty order','active','inactive',$3)`,
        [workflow, workspace, actor],
      );
      await db.query(
        `insert into app.workflow_versions (id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
       values($1,$2,$3,1,$4,'wf:sha256:'||repeat('e',64),'{}',$5)`,
        [
          version,
          workspace,
          workflow,
          {
            nodes: [
              {
                id: 'extract',
                label: 'Extract an order',
                definition: { key: 'ai.model', version: 1 },
                config: { headers: { authorization: settingsSentinel } },
              },
            ],
            edges: [],
          },
          actor,
        ],
      );
      await db.query(
        `insert into app.workflow_runs (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,started_at,completed_at,input_ref,input_ref_expires_at)
       values($1,$2,$3,$4,'manual','failed',statement_timestamp(),statement_timestamp(),$5,statement_timestamp()+interval '1 day')`,
        [
          run,
          workspace,
          workflow,
          version,
          { kind: 'inline', value: { prompt: payloadSentinel } },
        ],
      );
      await db.query(
        `insert into app.node_runs (id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,safe_error_code,completed_at)
       values($1,$2,$3,'extract','extract','{}','failed','safe','model.output_refused',statement_timestamp())`,
        [randomUUID(), workspace, run],
      );
      await db.query('commit');
      return run;
    } finally {
      await db.query('rollback');
      db.release();
    }
  }
});
