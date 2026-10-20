import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect } from 'vitest';
import type { Pool, QueryResultRow, QueryResult } from 'pg';
import type { WorkflowAuthoringDatabase } from '@pertexo/database/authoring';
import type {
  WebhookTestEventStore,
  TestEventScope,
} from '@pertexo/database/triggers';
import {
  registerWebhookIngress,
  type WebhookIngressDependencies,
} from '../../../src/webhooks/ingress.js';
import type { HttpSessionCookies } from '../support/browser-session.fixture.js';

interface Fixture {
  origin: string;
  scope: TestEventScope;
  revision: number;
  session: HttpSessionCookies;
  store: WebhookTestEventStore;
  ingress: WebhookIngressDependencies;
  authoring: WorkflowAuthoringDatabase;
  apiPool: Pool;
  issueSession: (userId: string) => Promise<HttpSessionCookies>;
  query: <Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ) => Promise<QueryResult<Row>>;
}
export async function qualifyWebhookTestEvents(f: Fixture) {
  const root = `${f.origin}/v1/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/draft/nodes/webhook/webhook-test-events`;
  async function manage(
    method: string,
    path = '',
    body?: unknown,
    cookie = f.session.cookieHeader,
  ) {
    return fetch(root + path, {
      method,
      headers: {
        cookie,
        'x-csrf-token': f.session.csrf,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
  }
  async function start(
    mode: 'signed' | 'secret_url' | 'header_secret' = 'signed',
    extra = {},
  ) {
    const response = await manage('POST', '', {
      expectedDraftRevision: f.revision,
      authentication: {
        mode,
        allowedOrigins:
          mode === 'signed' ? [] : ['https://sender.example.test'],
        ...(mode === 'header_secret' ? { headerName: 'x-event-secret' } : {}),
      },
      ...extra,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return (await response.json()) as {
      id: string;
      path: string;
      signingSecret?: string;
    };
  }
  async function send(
    listener: { path: string; signingSecret?: string },
    mode: string,
    body = '{"amount":17}',
    origin = f.origin,
  ) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const auth =
      mode === 'signed'
        ? {
            'x-pertexo-timestamp': timestamp,
            'x-pertexo-signature': `v1=${createHmac(
              'sha256',
              Buffer.from(listener.signingSecret ?? '', 'base64url'),
            )
              .update(`${timestamp}.${body}`)
              .digest('hex')}`,
          }
        : mode === 'header_secret'
          ? { 'x-event-secret': listener.signingSecret ?? '' }
          : {};
    return fetch(origin + listener.path + '?source=test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body,
      signal: AbortSignal.timeout(5000),
    });
  }
  const baseline = (
    await f.query<{ count: string }>(
      'select count(*)::text count from app.workflow_runs where workflow_id=$1',
      [f.scope.workflowId],
    )
  ).rows[0]?.count;
  for (const mode of ['signed', 'secret_url', 'header_secret'] as const) {
    const listener = await start(mode);
    expect(await (await manage('GET', `/${listener.id}`)).json()).toMatchObject(
      { state: 'waiting', output: null },
    );
    const bad = await fetch(f.origin + listener.path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-event-secret': 'wrong',
      },
      body: '{}',
    });
    if (mode !== 'secret_url') expect(bad.status).toBe(401);
    else {
      expect(bad.status).toBe(202);
      await start(mode);
      continue;
    }
    const response = await send(listener, mode);
    expect(response.status, mode).toBe(202);
    expect(await response.json()).toEqual({ captured: true });
    const captured = await manage('GET', `/${listener.id}`);
    expect(await captured.json()).toMatchObject({
      state: 'captured',
      output: { kind: 'inline', value: { amount: 17 } },
    });
    expect((await send(listener, mode)).status).toBe(401);
  }
  const listener = await start('secret_url');
  const preflight = await fetch(f.origin + listener.path, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://sender.example.test',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe(
    'https://sender.example.test',
  );
  expect(preflight.headers.has('access-control-allow-credentials')).toBe(false);
  expect(await (await manage('GET', `/${listener.id}`)).json()).toMatchObject({
    state: 'waiting',
  });
  const blocked = await fetch(f.origin + listener.path, {
    method: 'POST',
    headers: {
      origin: 'https://wrong.example.test',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  expect(blocked.status).toBe(401);
  const other = Fastify();
  registerWebhookIngress(other, f.ingress);
  await other.listen({ host: '127.0.0.1', port: 0 });
  try {
    const address = other.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('No replica address');
    const replies = await Promise.all([
      send(listener, 'secret_url', '{"winner":1}'),
      send(
        listener,
        'secret_url',
        '{"winner":2}',
        `http://127.0.0.1:${String(address.port)}`,
      ),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([202, 401]);
    const snapshot = await f.store.get({ ...f.scope, id: listener.id });
    expect(snapshot.state).toBe('captured');
    await f.authoring.stepSamples.put({
      ...f.scope,
      expectedDraftRevision: f.revision,
      expectedSampleId: null,
      idempotencyKey: randomUUID(),
      source: { kind: 'webhook_test', listenerId: listener.id },
    });
    const sample = await f.authoring.stepSamples.get(f.scope);
    expect(sample.output).toEqual(snapshot.output);
    expect(sample.sample?.state).toBe('pinned');
    expect(sample.sample?.source).toEqual({ kind: 'webhook_test' });
    const sampleId = sample.sample?.id;
    if (sampleId === undefined) throw new Error('Sample missing');
    await f.store.stop({ ...f.scope, id: listener.id });
    await f.authoring.stepSamples.put({
      ...f.scope,
      expectedDraftRevision: f.revision,
      expectedSampleId: sampleId,
      idempotencyKey: randomUUID(),
      source: { kind: 'confirm' },
    });
    expect((await f.authoring.stepSamples.get(f.scope)).sample?.source).toEqual(
      { kind: 'webhook_test' },
    );
    await expect(
      f.authoring.stepSamples.put({
        ...f.scope,
        expectedDraftRevision: f.revision,
        expectedSampleId:
          (await f.authoring.stepSamples.get(f.scope)).sample?.id ?? null,
        idempotencyKey: randomUUID(),
        source: { kind: 'webhook_test', listenerId: listener.id },
      }),
    ).rejects.toThrow('workflow.sample_source_unavailable');
  } finally {
    await other.close();
  }
  const stopped = await start('secret_url');
  expect((await manage('DELETE', `/${stopped.id}`)).status).toBe(204);
  expect((await send(stopped, 'secret_url')).status).toBe(401);
  const expired = await start('secret_url');
  await f.query(
    "update app.webhook_test_events set created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [expired.id],
  );
  expect((await send(expired, 'secret_url')).status).toBe(401);
  const replaced = await start('secret_url');
  await start('secret_url');
  expect((await send(replaced, 'secret_url')).status).toBe(401);
  const bounded = await start('secret_url');
  expect(
    (
      await send(
        bounded,
        'secret_url',
        JSON.stringify({ huge: 'x'.repeat(262144) }),
      )
    ).status,
  ).toBe(413);
  const deep = JSON.stringify({
    items: Array.from({ length: 10001 }, () => 1),
  });
  expect((await send(bounded, 'secret_url', deep)).status).toBe(413);
  expect(await (await manage('GET', `/${bounded.id}`)).json()).toMatchObject({
    state: 'waiting',
    output: null,
  });
  await f.query('update app.webhook_test_events set attempts=60 where id=$1', [
    bounded.id,
  ]);
  expect((await send(bounded, 'secret_url')).status).toBe(429);
  const changed = await start('secret_url');
  await f.query(
    `update app.workflow_drafts set graph_json=jsonb_set(graph_json::jsonb,'{nodes,0,config,runInput}','"request"'::jsonb),revision=revision+1 where workflow_id=$1`,
    [f.scope.workflowId],
  );
  expect((await send(changed, 'secret_url')).status).toBe(401);
  expect(await (await manage('GET', `/${changed.id}`)).json()).toMatchObject({
    state: 'changed',
    output: null,
  });
  expect(
    (
      await manage('POST', '', {
        expectedDraftRevision: f.revision,
        authentication: { mode: 'signed', allowedOrigins: [] },
      })
    ).status,
  ).toBe(409);
  f.revision++;
  const full = await start('header_secret');
  const fullResponse = await fetch(f.origin + full.path + '?order=17', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-event-secret': full.signingSecret ?? '',
      cookie: 'private=value',
      'x-forwarded-for': 'sensitive',
      'x-business': 'kept',
    },
    body: '{"safe":true}',
  });
  expect(fullResponse.status).toBe(202);
  const captured = (await (await manage('GET', `/${full.id}`)).json()) as {
    output: {
      value: { headers: Record<string, string>; body: unknown; query: unknown };
    };
  };
  expect(captured.output.value).toMatchObject({
    body: { safe: true },
    query: { order: '17' },
    headers: { 'x-business': 'kept' },
  });
  expect(captured.output.value.headers).not.toHaveProperty('cookie');
  expect(captured.output.value.headers).not.toHaveProperty('x-event-secret');
  expect(captured.output.value.headers).not.toHaveProperty('x-forwarded-for');
  const extraListeners: { workflowId: string; id: string }[] = [];
  for (let index = 0; index < 10; index++) {
    const created = await f.authoring.createWorkflow({
      actorId: f.scope.actorId,
      workspaceId: f.scope.workspaceId,
      name: 'Bounded capture',
      idempotencyKey: randomUUID(),
      emptyGraph: {
        settings: {},
        nodes: [
          {
            id: 'webhook',
            definition: { key: 'core.webhook', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
        ],
        edges: [],
      },
    });
    const response = await fetch(
      root.replace(f.scope.workflowId, created.workflowId),
      {
        method: 'POST',
        headers: {
          cookie: f.session.cookieHeader,
          'x-csrf-token': f.session.csrf,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedDraftRevision: created.draft.revision,
          authentication: { mode: 'secret_url', allowedOrigins: [] },
        }),
      },
    );
    expect(response.status).toBe(index < 9 ? 200 : 409);
    if (index < 9)
      extraListeners.push({
        workflowId: created.workflowId,
        ...((await response.json()) as { id: string }),
      });
  }
  for (const listener of extraListeners)
    await f.store.stop({ ...f.scope, ...listener });
  const viewer = randomUUID();
  await f.query(
    "insert into app.users(id,email,display_name,status) values($1,$2,'Sample viewer','active')",
    [viewer, `viewer-${viewer}@example.test`],
  );
  await f.query(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')",
    [f.scope.workspaceId, viewer],
  );
  const viewerSession = await f.issueSession(viewer);
  expect(
    (await manage('GET', `/${full.id}`, undefined, viewerSession.cookieHeader))
      .status,
  ).toBe(404);
  expect(
    (
      await fetch(
        root.replace(f.scope.workspaceId, randomUUID()) + `/${full.id}`,
        { headers: { cookie: f.session.cookieHeader } },
      )
    ).status,
  ).toBe(404);
  const archived = await start('secret_url');
  await f.query(
    "update app.workflows set lifecycle_status='archived' where id=$1",
    [f.scope.workflowId],
  );
  expect((await send(archived, 'secret_url')).status).toBe(401);
  await f.query(
    "update app.workflows set lifecycle_status='active' where id=$1",
    [f.scope.workflowId],
  );
  const removed = await start('secret_url');
  await f.query(
    "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
    [f.scope.workspaceId, f.scope.actorId],
  );
  expect((await send(removed, 'secret_url')).status).toBe(401);
  expect((await manage('GET', `/${removed.id}`)).status).toBe(404);
  expect(
    (await f.apiPool.query('select id from app.webhook_test_events')).rows,
  ).toEqual([]);
  expect(
    (
      await f.query<{ count: string }>(
        'select count(*)::text count from app.workflow_runs where workflow_id=$1',
        [f.scope.workflowId],
      )
    ).rows[0]?.count,
  ).toBe(baseline);
  expect(
    (
      await f.query(
        'select id from app.webhook_trigger_deliveries where workspace_id=$1',
        [f.scope.workspaceId],
      )
    ).rows,
  ).toEqual([]);
}
