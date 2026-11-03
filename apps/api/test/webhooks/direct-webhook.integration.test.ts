import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { assertIntegrationGateConfigured } from '../support/integration-gate.js';
import {
  adminBaseUrl,
  migrationBaseUrl,
  apiBaseUrl,
  requested,
  enabled,
  prepareDirectWebhookHTTPIntegrationFixture,
  closeDirectWebhookHTTPIntegrationFixture,
  apiPool,
  catalog,
  identityRuntime,
  authoring,
  webhookDatabase,
  encryption,
  testEvents,
  ingressDatabase,
  origin,
  seedWebhook,
  ownerQuery,
  service,
  application,
  consume,
  recordBenchmarkOperation,
  requireString,
  expectProblem,
  identity,
  workspaceId,
  apiQuery,
  sendWebhook,
  verificationControl,
  durableCounts,
  withOneMoreDelivery,
} from './direct-webhook/fixture.js';
import { qualifyWebhookTestEvents } from './test-events/qualify.js';
import { qualifyWebhookResponseWaiting } from './responses/qualify.js';
import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import { createInitialCheckpoint } from '@pertexo/core/runs';
import { issueBrowserSession } from './support/browser-session.fixture.js';
import { silentLogger } from '../support/silent-logger.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  browser,
  currentWebhookTrigger,
  deliver,
  listTriggers,
  publish,
  publishAndReconcile,
  runVersion,
  setStep,
  webhookStep,
  webhookThenSet,
  type Seeded,
} from './direct-webhook/publish-flow.js';
import {
  comparable,
  deliver as deliver2,
  holdRows,
  inWorkspace,
  PAUSE,
  rejectedRows,
  send,
  traces,
  deliver as deliver3,
  nowSeconds,
  signatureOf,
  ADMISSION_ROW,
  deliver as deliver4,
  endpointOf,
  type Seeded as Seeded2,
} from './direct-webhook/doors/support.js';
import { Writable } from 'node:stream';
import { createStructuredLogger } from '@pertexo/observability';
import Fastify from 'fastify';
import { registerWebhookIngress } from '../../src/webhooks/ingress/register.js';
import { apiProblemSchema } from '@pertexo/contracts';

/** A signed POST that carries no Idempotency-Key, as a simple sender sends it. */
async function sendWithoutKey(seeded: Seeded, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac(
    'sha256',
    Buffer.from(seeded.originalSecret, 'base64url'),
  )
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
  const response = await fetch(
    new URL(`/hooks/${seeded.endpointKey}`, origin),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pertexo-timestamp': timestamp,
        'x-pertexo-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(5000),
    },
  );
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function runCount(workspaceId: string) {
  const counted = await apiQuery<{ runs: number }>(
    `select count(*)::int runs from app.workflow_runs where workspace_id=$1`,
    [workspaceId],
  );
  return counted.rows[0]?.runs;
}

const CLOSED_DOORS: readonly (readonly [
  string,
  (seeded: Seeded2) => Promise<unknown>,
])[] = [
  [
    'a disabled endpoint',
    ({ workspaceId, workflowId }) =>
      inWorkspace(
        workspaceId,
        "update app.webhook_trigger_endpoints set status='disabled' where workflow_id=$1",
        [workflowId],
      ),
  ],
  [
    'an archived workflow',
    ({ workflowId }) =>
      ownerQuery(
        "update app.workflows set lifecycle_status='archived' where id=$1",
        [workflowId],
      ),
  ],
  [
    'a suspended workspace',
    ({ workspaceId }) =>
      ownerQuery("update app.workspaces set status='suspended' where id=$1", [
        workspaceId,
      ]),
  ],
  [
    'a workspace pending deletion',
    ({ workspaceId, actorId }) =>
      ownerQuery(
        `update app.workspaces set status='pending_deletion',
           deletion_requested_at=clock_timestamp(),deletion_requested_by=$2,
           deletion_reason='test',purge_after=clock_timestamp()+interval '30 days'
         where id=$1`,
        [workspaceId, actorId],
      ),
  ],
  [
    'a publish that removed the step',
    (seeded) =>
      publishAndReconcile(seeded, {
        settings: {},
        nodes: [
          {
            id: 'finish',
            definition: { key: 'core.terminate', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
        ],
        edges: [],
      }),
  ],
];

const BODY_WORDS = 'sender-body-words-7f3a';

const QUERY_WORDS = 'sender-query-words-7f3a';

const HEADER_WORDS = 'sender-header-words-7f3a';

const KEY_WORDS = 'sender-idempotency-words-7f3a';

/** The real logger, written somewhere a test can read, in front of the real database. */
async function ingressWithLogs() {
  let written = '';
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  const application = Fastify();
  registerWebhookIngress(application, {
    database: ingressDatabase,
    encryption,
    checkpointFactory: (projection) =>
      createInitialCheckpoint(projection, { catalog }),
    logger: createStructuredLogger(
      {
        serviceName: 'sender-words',
        serviceVersion: 'test',
        environment: 'test',
        logLevel: 'trace',
        otlpHeaders: {},
      },
      destination,
    ),
  });
  await application.ready();
  return { application, logs: () => written };
}

function signed(secret: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'idempotency-key': `${KEY_WORDS}-${randomUUID()}`,
    'x-sender-note': HEADER_WORDS,
    'x-pertexo-timestamp': timestamp,
    'x-pertexo-signature': `v1=${createHmac(
      'sha256',
      Buffer.from(secret, 'base64url'),
    )
      .update(`${timestamp}.${body}`)
      .digest('hex')}`,
  };
}

assertIntegrationGateConfigured({
  name: 'direct webhook HTTP integration',
  requested,
  required: {
    DATABASE_ADMIN_URL: adminBaseUrl,
    DATABASE_MIGRATION_URL: migrationBaseUrl,
    DATABASE_URL: apiBaseUrl,
  },
});
if (requested)
  console.info(
    '[integration-gate] direct webhook HTTP integration requested and configured; executing the required HTTP assertion',
  );
describe.runIf(enabled)('direct webhook HTTP integration', () => {
  beforeAll(prepareDirectWebhookHTTPIntegrationFixture, 120_000);

  afterAll(closeDirectWebhookHTTPIntegrationFixture, 30_000);
  it('captures one real test event before publication, across replicas, with authentication and pin fences', async () => {
    const seed = await seedWebhook('test-event-editor');
    const created = await authoring.createWorkflow({
      actorId: seed.actorId,
      workspaceId: seed.workspaceId,
      name: 'Unpublished webhook sample',
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
    const scope = {
      workspaceId: seed.workspaceId,
      workflowId: created.workflowId,
      nodeId: 'webhook',
      actorId: seed.actorId,
    };
    const session = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      seed.actorId,
    );
    await qualifyWebhookTestEvents({
      origin,
      scope,
      revision: created.draft.revision,
      session,
      store: testEvents,
      ingress: {
        database: ingressDatabase,
        testEvents,
        encryption,
        checkpointFactory: (projection) =>
          createInitialCheckpoint(projection, { catalog }),
        logger: silentLogger,
      },
      authoring,
      apiPool,
      query: ownerQuery,
      issueSession: (userId) =>
        issueBrowserSession(identityRuntime.dependencies.sessions, userId),
    });
  }, 30000);

  it('qualifies durable response waiting across independent API listeners and restart', async () => {
    await qualifyWebhookResponseWaiting({
      ingress: {
        database: webhookDatabase,
        encryption,
        checkpointFactory: (projection) =>
          createInitialCheckpoint(projection, { catalog }),
        logger: silentLogger,
      },
      seed: seedWebhook,
      query: ownerQuery,
    });
  }, 20_000);

  it('configures modes through authenticated HTTP and qualifies real CORS, deduplication and rotation', async () => {
    const seeded = await seedWebhook('authentication-modes');
    const session = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      seeded.actorId,
    );
    const path = `/v1/workspaces/${seeded.workspaceId}/workflows/${seeded.workflowId}/triggers/${seeded.trigger.id}/webhook/authentication`;
    const browserOrigin = 'https://browser.example';
    const commandKey = randomUUID();
    const headers = {
      cookie: session.cookieHeader,
      'x-csrf-token': session.csrf,
      'idempotency-key': commandKey,
    };
    const policy = { mode: 'secret_url', allowedOrigins: [browserOrigin] };
    const denied = await application.inject({
      method: 'POST',
      url: path,
      headers: {
        cookie: session.cookieHeader,
        'idempotency-key': randomUUID(),
      },
      payload: policy,
    });
    expect(denied.statusCode).toBe(403);
    const configured = await application.inject({
      method: 'POST',
      url: path,
      headers,
      payload: policy,
    });
    expect(configured.statusCode, configured.body).toBe(200);
    const result = configured.json<{
      endpointKey: string;
      signingSecret?: string;
      replayed: boolean;
    }>();
    expect(result.endpointKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.signingSecret).toBeUndefined();
    expect(
      (
        await application.inject({
          method: 'POST',
          url: path,
          headers,
          payload: policy,
        })
      ).json(),
    ).toMatchObject({ replayed: true });
    const endpoint = new URL(`/hooks/${result.endpointKey}`, origin);
    const preflight = await fetch(endpoint, {
      method: 'OPTIONS',
      headers: {
        origin: browserOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, idempotency-key',
      },
      signal: AbortSignal.timeout(5000),
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      browserOrigin,
    );
    expect(
      preflight.headers.get('access-control-allow-credentials'),
    ).toBeNull();
    await preflight.arrayBuffer();
    expect(
      consume.mock.calls.some(
        ([decision]) =>
          decision.endpointClass === 'webhook_preflight' &&
          decision.dimensions.some(
            (dimension) =>
              dimension.kind === 'client_address' && dimension.limit === 60,
          ),
      ),
    ).toBe(true);
    consume.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 5,
      limitedDimension: 'client_address',
    });
    const limitedPreflight = await fetch(endpoint, {
      method: 'OPTIONS',
      headers: {
        origin: browserOrigin,
        'access-control-request-method': 'POST',
      },
      signal: AbortSignal.timeout(5000),
    });
    expect(limitedPreflight.status).toBe(429);
    expect(limitedPreflight.headers.get('retry-after')).toBe('5');
    await limitedPreflight.arrayBuffer();

    const key = randomUUID();
    const send = (target: URL, extra: Record<string, string> = {}) =>
      fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          ...extra,
        },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
    const accepted = await send(endpoint, { origin: browserOrigin });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('access-control-allow-origin')).toBe(
      browserOrigin,
    );
    const receipt: unknown = await accepted.json();
    const duplicate = await send(endpoint, { origin: browserOrigin });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({
      ...(receipt as object),
      replayed: true,
    });
    const unlisted = await send(endpoint, { origin: 'https://other.example' });
    expect(unlisted.status).toBe(401);
    expect(unlisted.headers.get('access-control-allow-origin')).toBeNull();
    await unlisted.arrayBuffer();
    const old = await send(new URL(`/hooks/${seeded.endpointKey}`, origin));
    expect(old.status).toBe(401);
    await old.arrayBuffer();
    const next = await application.inject({
      method: 'POST',
      url: path,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: {
        mode: 'header_secret',
        headerName: 'authorization',
        allowedOrigins: [browserOrigin],
      },
    });
    expect(next.statusCode).toBe(200);
    const material = next.json<{
      endpointKey: string;
      signingSecret: string;
    }>();
    const target = new URL(`/hooks/${material.endpointKey}`, origin);
    const missing = await send(target);
    expect(missing.status).toBe(401);
    await missing.arrayBuffer();
    const valid = await send(target, {
      authorization: `Bearer ${material.signingSecret}`,
      origin: browserOrigin,
    });
    expect(valid.status).toBe(202);
    await valid.arrayBuffer();
    const beforeRotation = material.signingSecret;
    const rotated = await service.rotateSecret({
      ...seeded,
      triggerId: seeded.trigger.id,
      idempotencyKey: randomUUID(),
      endpointKey: material.endpointKey,
    });
    expect(rotated.replayed).toBe(false);
    const overlap = await send(target, {
      authorization: `Bearer ${beforeRotation}`,
    });
    expect(overlap.status).toBe(202);
    await overlap.arrayBuffer();
    const changedUrl = await send(endpoint);
    expect(changedUrl.status).toBe(401);
    await changedUrl.arrayBuffer();
    const counts = await ownerQuery<{ count: number }>(
      'select count(*)::int count from app.workflow_runs where workflow_id=$1',
      [seeded.workflowId],
    );
    expect(counts.rows[0]?.count).toBe(1);
    const allowance = await ownerQuery<{ request_count: number }>(
      `select allowance.request_count from app.webhook_endpoint_ingress_limits allowance
       join app.webhook_trigger_endpoints endpoint on endpoint.id=allowance.endpoint_id
       where endpoint.workflow_id=$1`,
      [seeded.workflowId],
    );
    expect(allowance.rows[0]?.request_count).toBe(6);
  });

  it('proves atomic acceptance, exact replay, and replay conflict', async () => {
    const { actorId, endpointKey, originalSecret, trigger, workflowId } =
      await seedWebhook('atomic');

    const rawBody = Buffer.from(
      '{  "raw-byte-marker" : "payload-value", "nested" : {"ok":true} }\n',
      'utf8',
    );
    const key = 'sender-delivery-key';
    const operationStartedAt = performance.now();
    const first = await sendWebhook(endpointKey, originalSecret, rawBody, key);
    recordBenchmarkOperation(operationStartedAt);
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ replayed: false });
    const runId = String(first.json.runId);
    const atomic = await apiQuery<{
      deliveries: number;
      runs: number;
      events: number;
      checkpoints: number;
      outbox: number;
    }>(
      `select
        (select count(*)::int from app.webhook_trigger_deliveries where workflow_run_id=$1) deliveries,
        (select count(*)::int from app.workflow_runs where id=$1 and status='queued' and trigger_type='webhook') runs,
        (select count(*)::int from app.run_events where workflow_run_id=$1 and sequence=1 and type='run.queued') events,
        (select count(*)::int from app.run_checkpoints where workflow_run_id=$1 and revision=0) checkpoints,
        (select count(*)::int from app.outbox_events where aggregate_id=$1 and job_name='advance-workflow-run') outbox`,
      [runId],
    );
    expect(atomic.rows).toEqual([
      { deliveries: 1, runs: 1, events: 1, checkpoints: 1, outbox: 1 },
    ]);

    const replay = await sendWebhook(endpointKey, originalSecret, rawBody, key);
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual({ runId, replayed: true });
    const concurrent = await Promise.all([
      sendWebhook(endpointKey, originalSecret, rawBody, key),
      sendWebhook(endpointKey, originalSecret, rawBody, key),
    ]);
    expect(concurrent.map(({ status }) => status)).toEqual([202, 202]);
    expect(concurrent.map(({ json }) => json)).toEqual([
      { runId, replayed: true },
      { runId, replayed: true },
    ]);
    const changed = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"raw-byte-marker":"changed"}\n'),
      key,
    );
    expectProblem(changed, 409, 'webhook.idempotency_conflict');

    // ADR 045: each attributed request left one metadata-only delivery fact.
    const log = await service.listDeliveries({
      workspaceId,
      workflowId,
      actorId,
      triggerId: trigger.id,
    });

    expect(
      log.items.map(({ outcome, httpStatus, replayCheck, runId }) => [
        outcome,
        httpStatus,
        replayCheck,
        runId,
      ]),
    ).toEqual([
      ['conflict', 409, 'conflict', null],
      ['replayed', 202, 'duplicate', runId],
      ['replayed', 202, 'duplicate', runId],
      ['replayed', 202, 'duplicate', runId],
      ['accepted', 202, 'new', runId],
    ]);
    expect(log.items.at(-1)).toMatchObject({
      signatureCheck: 'verified',
      byteLength: rawBody.byteLength,
    });
    expect(log.nextCursor).toBeNull();
  }, 60_000);

  it('keeps a published public webhook accepting after its workflow becomes private', async () => {
    const seeded = await seedWebhook('restricted-published');
    const folderId = randomUUID(),
      readerId = randomUUID();
    await identity.createUser({
      id: readerId,
      email: `${readerId}@example.test`,
      displayName: 'Unshared reader',
    });
    await ownerQuery(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
      [seeded.workspaceId, readerId],
    );
    expect(
      await authoring.getWorkflow(
        seeded.workspaceId,
        seeded.workflowId,
        readerId,
      ),
    ).not.toBeNull();
    await ownerQuery(
      "insert into app.workflow_folders(workspace_id,id,name,name_key,access_mode) values($1,$2,'Private public trigger','private public trigger','restricted')",
      [seeded.workspaceId, folderId],
    );
    await ownerQuery(
      'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3) on conflict(workspace_id,workflow_id) do update set folder_id=excluded.folder_id,revision=app.workflow_organization_state.revision+1',
      [seeded.workspaceId, seeded.workflowId, folderId],
    );
    expect(
      await authoring.getWorkflow(
        seeded.workspaceId,
        seeded.workflowId,
        readerId,
      ),
    ).toBeNull();
    const accepted = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      Buffer.from('{"privateWorkflow":true}'),
      randomUUID(),
    );
    expect(accepted.status).toBe(202);
    expect(
      (
        await apiQuery(
          'select status,trigger_type from app.workflow_runs where id=$1',
          [String(accepted.json.runId)],
        )
      ).rows,
    ).toEqual([{ status: 'queued', trigger_type: 'webhook' }]);
  });

  it('returns 202 for signed and Secret URL concurrency skips, with durable native history and one usage fact', async () => {
    const seeded = await seedWebhook('concurrency-skip');
    const raw = Buffer.from('{"event":"skip proof"}');
    const first = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      raw,
      'concurrency-first',
    );
    expect(first.status).toBe(202);
    await ownerQuery(
      `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')`,
      [workspaceId, seeded.workflowId],
    );
    const signed = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      raw,
      'concurrency-signed',
    );
    expect(signed.status).toBe(202);
    expect(signed.json).toEqual({ skipped: true, reason: 'concurrency_limit' });
    const session = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      seeded.actorId,
    );
    const policy = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows/${seeded.workflowId}/triggers/${seeded.trigger.id}/webhook/authentication`,
      headers: {
        cookie: session.cookieHeader,
        'x-csrf-token': session.csrf,
        'idempotency-key': randomUUID(),
      },
      payload: { mode: 'secret_url', allowedOrigins: [] },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    const key = requireString(
      policy.json<{ endpointKey: string }>().endpointKey,
    );
    const post = () =>
      application.inject({
        method: 'POST',
        url: `/hooks/${key}`,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'concurrency-url',
        },
        payload: raw,
      });
    const url = await post();
    expect(url.statusCode).toBe(202);
    expect(url.json()).toEqual({ skipped: true, reason: 'concurrency_limit' });
    expect((await post()).json()).toEqual(url.json());
    const history = await service.listDeliveries({
      workspaceId,
      workflowId: seeded.workflowId,
      actorId: seeded.actorId,
      triggerId: seeded.trigger.id,
    });
    expect(
      history.items.filter((item) => item.outcome === 'skipped'),
    ).toHaveLength(3);
    expect(
      (
        await ownerQuery(
          `select (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,(select count(*)::int from app.usage_events where resource_id=$1 and category='trigger.skipped') skips`,
          [seeded.workflowId],
        )
      ).rows,
    ).toEqual([{ runs: 1, skips: 2 }]);
  });

  it('reads a resumed run as running through authenticated HTTP', async () => {
    const { actorId, endpointKey, originalSecret } =
      await seedWebhook('run-status-read');
    const accepted = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"status":"read"}', 'utf8'),
      'run-status-read',
    );
    expect(accepted.status).toBe(202);
    const runId = String(accepted.json.runId);
    const { cookieHeader } = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      actorId,
    );
    const read = () =>
      application.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/runs/${runId}`,
        headers: { cookie: cookieHeader },
      });
    await ownerQuery(
      `update app.workflow_runs set status='waiting' where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    );
    const waiting = await read();
    expect(waiting.statusCode).toBe(200);
    expect(waiting.json()).toMatchObject({
      run: { id: runId, status: 'waiting' },
    });
    await ownerQuery(
      `update app.workflow_runs set status='running' where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    );
    const running = await read();
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({
      run: { id: runId, status: 'running' },
    });
  });

  it('rejects an authenticated malformed body with only a delivery-log fact', async () => {
    const { endpointKey, originalSecret } = await seedWebhook('malformed');
    const beforeMalformed = await durableCounts();
    const malformed = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"valid-signature":"invalid-json"'),
      'malformed-json',
    );
    expectProblem(malformed, 400, 'webhook.invalid_json');
    expect(await durableCounts()).toEqual(withOneMoreDelivery(beforeMalformed));
  }, 60_000);

  it('honors the previous-secret overlap and exact expiry boundary', async () => {
    const { actorId, endpointKey, originalSecret, trigger, workflowId } =
      await seedWebhook('rotation');
    const rotated = await service.rotateSecret({
      workspaceId,
      workflowId,
      actorId,
      triggerId: trigger.id,
      endpointKey,
      idempotencyKey: 'direct-webhook-rotate-secret',
    });
    const currentSecret = requireString(rotated.signingSecret);
    const oldBoundary = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"rotation":"previous-valid"}'),
      'rotation-previous-valid',
    );
    expect(oldBoundary.status).toBe(202);
    const expired = await apiQuery(
      `update app.webhook_trigger_endpoints
        set previous_secret_valid_until=clock_timestamp()-interval '1 second'
        where workspace_id=$1 and workflow_id=$2 returning id`,
      [workspaceId, workflowId],
    );
    expect(expired.rowCount).toBe(1);
    const expiredPrevious = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"rotation":"previous-expired"}'),
      'rotation-previous-expired',
    );
    expectProblem(expiredPrevious, 401, 'webhook.authentication_failed');
    const currentBoundary = await sendWebhook(
      endpointKey,
      currentSecret,
      Buffer.from('{"rotation":"current-valid"}'),
      'rotation-current-valid',
    );
    expect(currentBoundary.status).toBe(202);
  }, 60_000);

  it('rolls back admission but records the throttled delivery when quota rejects it', async () => {
    const { endpointKey, originalSecret } = await seedWebhook('quota');
    const accepted = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"quota":"baseline"}'),
      'quota-baseline',
    );
    expect(accepted.status).toBe(202);
    const queued = await ownerQuery<{ count: number }>(
      `select count(*)::int count from app.workflow_runs
        where workspace_id=$1 and status='queued'`,
      [workspaceId],
    );
    const queuedCount = queued.rows[0]?.count ?? 0;
    await ownerQuery(
      `insert into app.workspace_execution_entitlement_versions
        (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values($1,2,'active',5,$2,'-infinity'::timestamptz)`,
      [workspaceId, queuedCount],
    );
    await ownerQuery(
      `update app.workspace_execution_entitlements set current_version=2
        where workspace_id=$1`,
      [workspaceId],
    );
    const beforeQuota = await durableCounts();
    const quota = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"quota":"rejected"}'),
      'quota-rejected',
    );
    expectProblem(quota, 429, 'webhook.rate_limited');
    expect(quota.headers['retry-after']).toBe('5');
    expect(await durableCounts()).toEqual(withOneMoreDelivery(beforeQuota));
  }, 60_000);

  it('keeps authentication material out of durable surfaces and queues references only', async () => {
    const { endpointKey, originalSecret } = await seedWebhook('disclosure');
    const rawBody = Buffer.from(
      '{  "raw-byte-marker" : "payload-value", "nested" : {"ok":true} }\n',
      'utf8',
    );
    const first = await sendWebhook(
      endpointKey,
      originalSecret,
      rawBody,
      'disclosure-request',
    );
    expect(first.status).toBe(202);
    const nonInputDurableText =
      (
        await apiQuery<{ surface: string }>(
          `select string_agg(surface,E'\n') surface from (
          select to_jsonb(delivery)::text surface from app.webhook_trigger_deliveries delivery where workspace_id=$1
          union all select to_jsonb(replay)::text from app.webhook_trigger_replay_records replay where workspace_id=$1
          union all select to_jsonb(event)::text from app.run_events event where workspace_id=$1
          union all select to_jsonb(checkpoint)::text from app.run_checkpoints checkpoint where workspace_id=$1
          union all select to_jsonb(outbox)::text from app.outbox_events outbox where workspace_id=$1
        ) durable`,
          [workspaceId],
        )
      ).rows[0]?.surface ?? '';
    const runId = String(first.json.runId);
    const runRows = await apiQuery<{ input_ref: unknown; surface: string }>(
      `select input_ref,to_jsonb(run)::text surface
         from app.workflow_runs run where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    );
    expect(runRows.rows).toMatchObject([
      {
        input_ref: {
          kind: 'inline',
          value: {
            'raw-byte-marker': 'payload-value',
            nested: { ok: true },
          },
        },
      },
    ]);
    const signature = first.requestMaterial.signature;
    expect(nonInputDurableText).not.toContain(rawBody.toString('utf8'));
    const allDurableText = `${nonInputDurableText}\n${runRows.rows[0]?.surface ?? ''}`;
    expect(allDurableText).not.toContain(signature);
    expect(allDurableText).not.toContain(endpointKey);
    expect(allDurableText).not.toContain(originalSecret);
    const queuedPayloads = await apiQuery<{ payload: unknown }>(
      `select payload from app.outbox_events where workspace_id=$1
        and job_name='advance-workflow-run'`,
      [workspaceId],
    );
    expect(
      queuedPayloads.rows.every(({ payload }) => {
        const value = payload as Record<string, unknown>;
        return (
          Object.keys(value).sort().join(',') ===
          'outboxEventId,runId,workspaceId'
        );
      }),
    ).toBe(true);
  }, 60_000);

  it('maps an injected verification-adapter outage without claiming a database timeout', async () => {
    const { endpointKey, originalSecret } = await seedWebhook('outage');
    verificationControl.failVerification = true;
    try {
      const unavailable = await sendWebhook(
        endpointKey,
        originalSecret,
        Buffer.from('{"verification-adapter":"unavailable"}'),
        'verification-adapter-unavailable',
      );
      expectProblem(unavailable, 503, 'webhook.unavailable');
    } finally {
      verificationControl.failVerification = false;
    }
  }, 60_000);

  it('takes a webhook only while the workspace is active', async () => {
    const { endpointKey, originalSecret, workspaceId } =
      await seedWebhook('workspace-state');
    const deliver = () =>
      sendWebhook(endpointKey, originalSecret, Buffer.from('{}'), randomUUID());
    const runs = async () =>
      (
        await apiQuery<{ runs: number }>(
          `select count(*)::int runs from app.workflow_runs where workspace_id=$1`,
          [workspaceId],
        )
      ).rows[0]?.runs;

    expect((await deliver()).status).toBe(202);
    expect(await runs()).toBe(1);

    await ownerQuery(
      `update app.workspaces set status='suspended' where id=$1`,
      [workspaceId],
    );
    // Unknown and closed endpoints answer alike, so the state isn't disclosed.
    expect((await deliver()).status).toBe(401);
    expect(await runs()).toBe(1);
  });

  it('returns no endpoint credential on a completed endpoint-rotation replay', async () => {
    const { actorId, trigger, workflowId } = await seedWebhook('management');
    const endpointRotation = {
      workspaceId,
      workflowId,
      actorId,
      triggerId: trigger.id,
      idempotencyKey: 'direct-webhook-rotate-endpoint',
    };
    const rotatedEndpoint = await service.rotateEndpoint(endpointRotation);
    expect(rotatedEndpoint.endpointKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(service.rotateEndpoint(endpointRotation)).resolves.toEqual({
      trigger: rotatedEndpoint.trigger,
      replayed: true,
    });
  }, 60_000);

  it('keeps taking deliveries at the same address with the same secret after a publish, on the new version', async () => {
    const seeded = await seedWebhook('survives-input-change');
    expect((await deliver(seeded)).status).toBe(202);
    const v2 = await publishAndReconcile(seeded, webhookThenSet(1));
    const afterV2 = await deliver(seeded);
    expect(afterV2.status).toBe(202);
    expect(await runVersion(seeded.workspaceId, afterV2.json.runId)).toBe(v2);
    const v3 = await publishAndReconcile(seeded, webhookThenSet(2));
    const afterV3 = await deliver(seeded);
    expect(afterV3.status).toBe(202);
    expect(await runVersion(seeded.workspaceId, afterV3.json.runId)).toBe(v3);
  }, 60_000);

  it('still reports one active, ready endpoint for the step after a publish', async () => {
    const seeded = await seedWebhook('survives-health');
    await publishAndReconcile(seeded, webhookThenSet(1));
    expect(await currentWebhookTrigger(seeded)).toMatchObject({
      kind: 'webhook',
      status: 'active',
      endpointReady: true,
    });
  }, 60_000);

  it('keeps the delivery history of the endpoint across a publish', async () => {
    const seeded = await seedWebhook('survives-history');
    const before = await deliver(seeded);
    expect(before.status).toBe(202);
    await publishAndReconcile(seeded, webhookThenSet(1));
    const after = await deliver(seeded);
    expect(after.status).toBe(202);
    const trigger = await currentWebhookTrigger(seeded);
    const { session, triggersPath } = await browser(seeded);
    const history = await application.inject({
      method: 'GET',
      url: `${triggersPath}/${trigger.id}/webhook/deliveries`,
      headers: { cookie: session.cookieHeader },
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(
      history
        .json<{ items: { outcome: string; runId: string | null }[] }>()
        .items.map(({ outcome, runId }) => [outcome, runId]),
    ).toEqual([
      ['accepted', after.json.runId],
      ['accepted', before.json.runId],
    ]);
  }, 60_000);

  it('refuses no delivery while a publish lands on a live endpoint', async () => {
    const seeded = await seedWebhook('survives-while-live');
    const statuses: number[] = [];
    const sending = { on: true };
    const sender = (async () => {
      while (sending.on) {
        statuses.push((await deliver(seeded)).status);
        // Stays under the endpoint's per-minute allowance across the publish.
        await delay(150);
      }
    })();
    await delay(300);
    const published = await publish(seeded, webhookThenSet(1));
    // Before the worker takes the job, the endpoint must already be answering.
    await delay(300);
    await published.reconcile();
    await delay(300);
    sending.on = false;
    await sender;
    expect(statuses.length).toBeGreaterThan(3);
    expect(new Set(statuses)).toEqual(new Set([202]));
  }, 60_000);

  it.each([
    {
      name: 'secret URL',
      policy: { mode: 'secret_url', allowedOrigins: [] },
      credentialHeaders: (): Record<string, string> => ({}),
    },
    {
      name: 'header secret',
      policy: {
        mode: 'header_secret',
        headerName: 'authorization',
        allowedOrigins: [],
      },
      credentialHeaders: (secret: string | undefined) => ({
        authorization: `Bearer ${String(secret)}`,
      }),
    },
  ])(
    'keeps the $name mode and its credential after a publish',
    async ({ policy, credentialHeaders }) => {
      const seeded = await seedWebhook(`survives-${policy.mode}`);
      const { session, triggersPath } = await browser(seeded);
      const configured = await application.inject({
        method: 'POST',
        url: `${triggersPath}/${seeded.trigger.id}/webhook/authentication`,
        headers: {
          cookie: session.cookieHeader,
          'x-csrf-token': session.csrf,
          'idempotency-key': randomUUID(),
        },
        payload: policy,
      });
      expect(configured.statusCode, configured.body).toBe(200);
      const { endpointKey, signingSecret } = configured.json<{
        endpointKey: string;
        signingSecret?: string;
      }>();
      const send = () =>
        fetch(new URL(`/hooks/${endpointKey}`, origin), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            ...credentialHeaders(signingSecret),
          },
          body: '{}',
          signal: AbortSignal.timeout(5000),
        });
      const before = await send();
      await before.arrayBuffer();
      expect(before.status).toBe(202);
      await publishAndReconcile(seeded, webhookThenSet(1));
      const after = await send();
      await after.arrayBuffer();
      expect(after.status).toBe(202);
      expect(await currentWebhookTrigger(seeded)).toMatchObject({
        status: 'active',
      });
    },
    60_000,
  );

  it('keeps a rotated secret and the overlap of the previous one across a publish', async () => {
    const seeded = await seedWebhook('survives-rotation');
    const rotated = await service.rotateSecret({
      ...seeded,
      triggerId: seeded.trigger.id,
      idempotencyKey: randomUUID(),
      endpointKey: seeded.endpointKey,
    });
    const nextSecret = rotated.signingSecret;
    if (nextSecret === undefined) throw new Error('Rotated secret missing');
    await publishAndReconcile(seeded, webhookThenSet(1));
    expect((await deliver(seeded)).status).toBe(202);
    expect(
      (
        await sendWebhook(
          seeded.endpointKey,
          nextSecret,
          Buffer.from('{}'),
          randomUUID(),
        )
      ).status,
    ).toBe(202);
  }, 60_000);

  it('retires only the removed step when a workflow has two webhook steps', async () => {
    const seeded = await seedWebhook('survives-two-steps');
    const twoWebhooks = {
      settings: {},
      nodes: [
        webhookStep,
        { ...webhookStep, id: 'second', position: { x: 0, y: 200 } },
      ],
      edges: [],
    };
    await publishAndReconcile(seeded, twoWebhooks);
    const second = await currentWebhookTrigger(seeded, 'second');
    const provisioned = await service.provision({
      workspaceId: seeded.workspaceId,
      workflowId: seeded.workflowId,
      actorId: seeded.actorId,
      triggerId: second.id,
      idempotencyKey: randomUUID(),
    });
    const sendSecond = () =>
      sendWebhook(
        String(provisioned.endpointKey),
        String(provisioned.signingSecret),
        Buffer.from('{}'),
        randomUUID(),
      );
    expect((await deliver(seeded)).status).toBe(202);
    expect((await sendSecond()).status).toBe(202);

    await publishAndReconcile(seeded, {
      settings: {},
      nodes: [{ ...webhookStep, id: 'second', position: { x: 0, y: 200 } }],
      edges: [],
    });
    expect((await deliver(seeded)).status).toBe(401);
    expect((await sendSecond()).status).toBe(202);
  }, 60_000);

  it('retires the endpoint when the publish removes its step', async () => {
    const seeded = await seedWebhook('retires-removed-step');
    expect((await deliver(seeded)).status).toBe(202);
    await publishAndReconcile(seeded, {
      settings: {},
      nodes: [
        {
          ...setStep(1),
          id: 'manual',
          definition: { key: 'core.manual', version: 1 },
          inputMappings: {},
        },
        setStep(1),
      ],
      edges: [
        {
          id: 'manual-apply',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'apply', port: 'in' },
        },
      ],
    });
    expect((await deliver(seeded)).status).toBe(401);
    const live = (await listTriggers(seeded)).filter(
      (item) => item.kind === 'webhook' && item.status !== 'disabled',
    );
    expect(live).toEqual([]);
  }, 60_000);

  it('keeps answering between the publish and the worker taking its job', async () => {
    const seeded = await seedWebhook('between-publish-and-reconcile');
    const before = await deliver(seeded);
    const v1 = await runVersion(seeded.workspaceId, before.json.runId);
    const { versionId: v2 } = await publish(seeded, webhookThenSet(1));
    const between = await deliver(seeded);
    expect(between.status).toBe(202);
    // Either version is a whole published workflow; both are honest here.
    expect([v1, v2]).toContain(
      await runVersion(seeded.workspaceId, between.json.runId),
    );
  }, 60_000);

  it('answers on a republished version from its commit, and stays ready once the worker takes that publication', async () => {
    const seeded = await seedWebhook('survives-republish');
    const first = await publishAndReconcile(seeded, webhookThenSet(1));
    await publishAndReconcile(seeded, webhookThenSet(2));
    const republished = await publish(seeded, webhookThenSet(1));
    expect(republished.versionId).toBe(first);
    const between = await deliver(seeded);
    expect(between.status).toBe(202);
    expect(await runVersion(seeded.workspaceId, between.json.runId)).toBe(
      first,
    );
    await republished.reconcile();
    expect(await currentWebhookTrigger(seeded)).toMatchObject({
      status: 'active',
      endpointReady: true,
    });
    const after = await deliver(seeded);
    expect(after.status).toBe(202);
    expect(await runVersion(seeded.workspaceId, after.json.runId)).toBe(first);
  }, 60_000);

  it('stores the endpoint key only as a hash, before and after a publish', async () => {
    const seeded = await seedWebhook('key-stays-hashed');
    const stored = async () =>
      JSON.stringify(
        (
          await apiQuery(
            'select to_jsonb(endpoint) row from app.webhook_trigger_endpoints endpoint where workspace_id=$1',
            [seeded.workspaceId],
          )
        ).rows,
      );
    expect(await stored()).not.toContain(seeded.endpointKey);
    await publishAndReconcile(seeded, webhookThenSet(1));
    expect(await stored()).not.toContain(seeded.endpointKey);
  }, 60_000);

  it('starts a run for each identical signed delivery that carries no key', async () => {
    const seeded = await seedWebhook('no-key-sequential');
    const first = await sendWithoutKey(seeded, '{"button":"pressed"}');
    const second = await sendWithoutKey(seeded, '{"button":"pressed"}');
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(first.json.replayed).toBe(false);
    expect(second.json.replayed).toBe(false);
    expect(second.json.runId).not.toBe(first.json.runId);
    expect(await runCount(seeded.workspaceId)).toBe(2);
    const log = await service.listDeliveries({
      workspaceId: seeded.workspaceId,
      workflowId: seeded.workflowId,
      actorId: seeded.actorId,
      triggerId: seeded.trigger.id,
    });
    expect(log.items.map(({ outcome }) => outcome)).toEqual([
      'accepted',
      'accepted',
    ]);
  }, 60_000);

  it('starts one run per delivery when identical keyless deliveries race', async () => {
    const seeded = await seedWebhook('no-key-concurrent');
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => sendWithoutKey(seeded, '{}')),
    );
    expect(responses.map(({ status }) => status)).toEqual(
      Array.from({ length: 5 }, () => 202),
    );
    expect(new Set(responses.map(({ json }) => json.runId)).size).toBe(5);
    expect(await runCount(seeded.workspaceId)).toBe(5);
  }, 60_000);

  it('starts a run for each identical keyless GET at a secret URL', async () => {
    const seeded = await seedWebhook('no-key-get');
    const { session, triggersPath } = await browser(seeded);
    const configured = await application.inject({
      method: 'POST',
      url: `${triggersPath}/${seeded.trigger.id}/webhook/authentication`,
      headers: {
        cookie: session.cookieHeader,
        'x-csrf-token': session.csrf,
        'idempotency-key': randomUUID(),
      },
      payload: { mode: 'secret_url', allowedOrigins: [] },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    const { endpointKey } = configured.json<{ endpointKey: string }>();
    const ping = async () => {
      const response = await fetch(
        new URL(`/hooks/${endpointKey}?source=monitor`, origin),
        { signal: AbortSignal.timeout(5000) },
      );
      expect(response.status).toBe(202);
      return (await response.json()) as Record<string, unknown>;
    };
    const first = await ping();
    const second = await ping();
    expect(second.runId).not.toBe(first.runId);
    expect(await runCount(seeded.workspaceId)).toBe(2);
  }, 60_000);

  it('still deduplicates when the sender names the event with a key', async () => {
    const seeded = await seedWebhook('explicit-key');
    const key = randomUUID();
    const body = Buffer.from('{"order":"A-17"}');
    const first = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      body,
      key,
    );
    const repeat = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      body,
      key,
    );
    expect(first.status).toBe(202);
    expect(repeat.status).toBe(202);
    expect(repeat.json).toEqual({ runId: first.json.runId, replayed: true });
    expect(await runCount(seeded.workspaceId)).toBe(1);
  }, 60_000);

  it.each(CLOSED_DOORS)(
    'answers %s exactly as an unknown address: 401, no delivery row, no limit spent',
    async (_name, close) => {
      const seeded = await seedWebhook(`closed-${randomUUID()}`);
      expect((await deliver2(seeded)).status).toBe(202);
      await close(seeded);
      const before = await traces(seeded);
      expect(before.spent).toBe(1);

      const closed = await deliver2(seeded);
      const unknown = await send(randomBytes(32).toString('base64url'), {
        secret: seeded.originalSecret,
      });

      expect(closed.status).toBe(401);
      expect(closed.body).toMatchObject({
        code: 'webhook.authentication_failed',
      });
      expect(comparable(closed)).toEqual(comparable(unknown));
      expect(await traces(seeded)).toEqual(before);
    },
    60_000,
  );

  it('tells a paused workflow only to a sender who proved the signature', async () => {
    const seeded = await seedWebhook(`paused-${randomUUID()}`);
    expect((await deliver2(seeded)).status).toBe(202);
    await ownerQuery(PAUSE, [seeded.workflowId]);
    const unsigned = await send(seeded.endpointKey, {});
    const unknown = await send(randomBytes(32).toString('base64url'), {});
    expect(comparable(unsigned)).toEqual(comparable(unknown));

    const before = await traces(seeded);
    const signed = await deliver2(seeded);
    expect(signed.status).toBe(423);
    expect(signed.body).toMatchObject({ code: 'webhook.workflow_paused' });
    expect((await traces(seeded)).runs).toBe(before.runs);
  }, 60_000);

  it.each([
    [
      'an archive',
      "update app.workflows set lifecycle_status='archived' where id=$1",
      401,
    ],
    ['a pause', PAUSE, 423],
  ] as const)(
    'refuses a sender waiting on the lock while %s commits, and starts nothing',
    async (_name, statement, status) => {
      const seeded = await seedWebhook(`wait-${randomUUID()}`);
      expect((await deliver2(seeded)).status).toBe(202);
      const before = await traces(seeded);
      const holder = await holdRows(seeded.workspaceId);
      try {
        await holder.client.query(statement, [seeded.workflowId]);
        const waiting = deliver2(seeded);
        await holder.waitForWaiters(1);
        await holder.finish();
        const answered = await waiting;
        expect(answered.status).toBe(status);
        expect(await traces(seeded)).toEqual({
          ...before,
          // The sender proved itself, so its attempt is on the owner's log (ADR 045).
          rejected: before.rejected + 1,
          spent: before.spent + 1,
        });
        expect(await rejectedRows(seeded)).toMatchObject([
          { http_status: status },
        ]);
      } finally {
        await holder.finish();
      }
    },
    60_000,
  );

  it('refuses a signature that is wrong, old, from the future, missing or for other bytes', async () => {
    const seeded = await seedWebhook(`signature-${randomUUID()}`);
    const key = seeded.endpointKey;
    const secret = seeded.originalSecret;
    const before = await traces(seeded);
    const timestamp = String(nowSeconds());
    const attempts: readonly (readonly [string, Parameters<typeof send>[1]])[] =
      [
        ['no proof at all', {}],
        ['a wrong secret', { secret: randomBytes(32).toString('base64url') }],
        [
          'a captured request from an hour ago',
          {
            secret,
            timestamp: String(nowSeconds() - 3_600),
          },
        ],
        [
          'one just past the five minute allowance',
          {
            secret,
            timestamp: String(nowSeconds() - 310),
          },
        ],
        [
          'a timestamp from the future',
          {
            secret,
            timestamp: String(nowSeconds() + 3_600),
          },
        ],
        [
          'a signature without its timestamp',
          {
            headers: {
              'x-pertexo-signature': signatureOf(secret, timestamp, '{}'),
            },
          },
        ],
        [
          'a timestamp without its signature',
          {
            headers: { 'x-pertexo-timestamp': timestamp },
          },
        ],
        [
          'a signature over other bytes',
          {
            body: '{"amount":1000000}',
            headers: {
              'x-pertexo-timestamp': timestamp,
              'x-pertexo-signature': signatureOf(secret, timestamp, '{}'),
            },
          },
        ],
        [
          'a signature in the wrong scheme',
          {
            headers: {
              'x-pertexo-timestamp': timestamp,
              'x-pertexo-signature': signatureOf(
                secret,
                timestamp,
                '{}',
              ).replace('v1=', 'v0='),
            },
          },
        ],
      ];
    const reference = comparable(await send(key, {}));
    expect(reference.status).toBe(401);
    for (const [name, attempt] of attempts) {
      const answered = comparable(await send(key, attempt));
      expect(answered, name).toEqual(reference);
    }
    const after = await traces(seeded);
    expect(after.runs).toBe(before.runs);
    expect(after.accepted).toBe(before.accepted);
    expect(
      (await rejectedRows(seeded)).map(({ http_status }) => http_status),
    ).toEqual(Array.from({ length: attempts.length + 1 }, () => 401));
  }, 60_000);

  it('answers a replayed request once: same key returns the first run, other bytes conflict', async () => {
    const seeded = await seedWebhook(`replay-${randomUUID()}`);
    const idempotencyKey = randomUUID();
    const first = await send(seeded.endpointKey, {
      secret: seeded.originalSecret,
      idempotencyKey,
    });
    expect(first.status).toBe(202);
    const replayed = await send(seeded.endpointKey, {
      secret: seeded.originalSecret,
      idempotencyKey,
    });
    expect(replayed.status).toBe(202);
    expect(replayed.body).toMatchObject({
      runId: first.body.runId,
      replayed: true,
    });
    const changed = await send(seeded.endpointKey, {
      secret: seeded.originalSecret,
      idempotencyKey,
      body: '{"other":true}',
    });
    expect(changed.status).toBe(409);
    expect((await traces(seeded)).runs).toBe(1);
  }, 60_000);

  it('takes the previous secret inside its window and not a moment after', async () => {
    const seeded = await seedWebhook(`window-${randomUUID()}`);
    const rotated = await service.rotateSecret({
      workspaceId: seeded.workspaceId,
      workflowId: seeded.workflowId,
      actorId: seeded.actorId,
      triggerId: seeded.trigger.id,
      endpointKey: seeded.endpointKey,
      idempotencyKey: randomUUID(),
    });
    const next = rotated.signingSecret;
    if (next === undefined) throw new Error('Expected the next secret');
    expect((await deliver3(seeded)).status).toBe(202);
    await inWorkspace(
      seeded.workspaceId,
      `update app.webhook_trigger_endpoints
          set previous_secret_valid_until=clock_timestamp()-interval '1 millisecond'
        where workflow_id=$1`,
      [seeded.workflowId],
    );
    const before = await traces(seeded);
    expect((await deliver3(seeded)).status).toBe(401);
    expect((await traces(seeded)).runs).toBe(before.runs);
    expect((await send(seeded.endpointKey, { secret: next })).status).toBe(202);
  }, 60_000);

  it('lets three deliveries of a busy workspace on the database at a time, the fourth waiting off it, and accepts them all', async () => {
    const seeded = await seedWebhook(`turns-${randomUUID()}`);
    const holder = await holdRows(seeded.workspaceId);
    try {
      await holder.client.query(ADMISSION_ROW, [seeded.workspaceId]);
      const line = Array.from({ length: 4 }, () => deliver4(seeded));
      await holder.waitForWaiters(3);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await holder.waiting()).toBe(3);
      await holder.finish();
      const answers = await Promise.all(line);
      expect(answers.map(({ status }) => status)).toEqual([202, 202, 202, 202]);
      expect((await traces(seeded)).runs).toBe(4);
    } finally {
      await holder.finish();
    }
  }, 60_000);

  it('answers 429 with Retry-After once the line outlasts its wait, and other workspaces keep being served', async () => {
    const other = await seedWebhook(`burst-other-${randomUUID()}`);
    const seeded = await seedWebhook(`burst-${randomUUID()}`);
    const holder = await holdRows(seeded.workspaceId);
    try {
      await holder.client.query(ADMISSION_ROW, [seeded.workspaceId]);
      // Each three at a time give up on the row at the lock timeout, so the line only
      // reaches its 20 second wait with this many in it.
      const line = Array.from({ length: 16 }, () => deliver4(seeded));
      await holder.waitForWaiters(3);
      expect((await deliver4(other)).status).toBe(202);
      const answers = await Promise.all(line);
      const refused = answers.filter(({ status }) => status === 429);
      const timedOut = answers.filter(({ status }) => status === 503);
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.length + timedOut.length).toBe(answers.length);
      for (const answer of refused) {
        expect(answer.body).toMatchObject({ code: 'webhook.rate_limited' });
        expect(answer.headers['retry-after']).toBe('5');
      }
      for (const answer of timedOut)
        expect(Number(answer.headers['retry-after'])).toBeGreaterThan(0);
      expect((await traces(seeded)).runs).toBe(0);
      expect(
        (await rejectedRows(seeded)).filter(
          ({ outcome }) => outcome === 'rate_limited',
        ),
      ).toHaveLength(refused.length);
      await holder.finish();
      // Nothing stays stuck once the row is free.
      expect((await deliver4(seeded)).status).toBe(202);
    } finally {
      await holder.finish();
    }
  }, 90_000);

  it.each([
    ['provision', 'naming a mode', { authentication: { mode: 'secret_url' } }],
    ['provision', 'naming nothing we know', { anything: true }],
    [
      'rotate-endpoint',
      'naming a mode',
      { authentication: { mode: 'secret_url' } },
    ],
    ['rotate-endpoint', 'naming nothing we know', { anything: true }],
  ] as const)(
    '%s refuses a body %s and changes nothing, then works with none or {}',
    async (command, _name, payload) => {
      const seeded = await seedWebhook(`body-${randomUUID()}`);
      const session = await issueBrowserSession(
        identityRuntime.dependencies.sessions,
        seeded.actorId,
      );
      const url = `/v1/workspaces/${seeded.workspaceId}/workflows/${seeded.workflowId}/triggers/${seeded.trigger.id}/webhook/${command}`;
      const headers = (key: string) => ({
        cookie: session.cookieHeader,
        'x-csrf-token': session.csrf,
        'idempotency-key': key,
      });
      const endpoint = await endpointOf(seeded);
      const receipts = async () =>
        (
          await inWorkspace<{ count: number }>(
            seeded.workspaceId,
            `select count(*)::int count from app.idempotency_records
              where workspace_id=$1 and operation like 'webhook.trigger.%'`,
            [seeded.workspaceId],
          )
        ).rows[0]?.count;
      const receiptsBefore = await receipts();

      const refused = await application.inject({
        method: 'POST',
        url,
        headers: headers(randomUUID()),
        payload,
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'request.invalid' });
      expect(await endpointOf(seeded)).toEqual(endpoint);
      expect(await receipts()).toBe(receiptsBefore);

      if (command === 'rotate-endpoint') {
        const withEmptyObject = await application.inject({
          method: 'POST',
          url,
          headers: headers(randomUUID()),
          payload: {},
        });
        expect(withEmptyObject.statusCode, withEmptyObject.body).toBe(200);
        const firstHash = (await endpointOf(seeded)).endpoint_key_hash;
        expect(firstHash).not.toBe(endpoint.endpoint_key_hash);
        const withNoBody = await application.inject({
          method: 'POST',
          url,
          headers: headers(randomUUID()),
        });
        expect(withNoBody.statusCode, withNoBody.body).toBe(200);
        expect((await endpointOf(seeded)).endpoint_key_hash).not.toBe(
          firstHash,
        );
        return;
      }
      // Provisioned already, so the same request is its receipt, with or without a body.
      for (const request of [{ payload: {} }, {}]) {
        const answered = await application.inject({
          method: 'POST',
          url,
          headers: headers(`direct-webhook-provision-${seeded.provisionLabel}`),
          ...request,
        });
        expect(answered.statusCode, answered.body).toBe(200);
      }
      expect(await endpointOf(seeded)).toEqual(endpoint);
    },
    60_000,
  );

  it('logs nothing a sender wrote, even when the database fails on the insert that carries it', async () => {
    const seeded = await seedWebhook(`logs-${randomUUID()}`);
    const { application, logs } = await ingressWithLogs();
    const body = JSON.stringify({ note: BODY_WORDS });
    const url = `/hooks/${seeded.endpointKey}?note=${QUERY_WORDS}`;
    const send = (headers: Record<string, string>) =>
      application.inject({ method: 'POST', url, headers, payload: body });
    // Fails the way an outage or a timeout does: on the statement holding the input.
    await ownerQuery(`
      create function app.test_fail_run_insert() returns trigger language plpgsql as $$
      begin raise exception 'forced failure' using errcode='XX000'; end $$`);
    await ownerQuery(`
      create trigger test_fail_run_insert before insert on app.workflow_runs
      for each row execute function app.test_fail_run_insert()`);
    try {
      const failed = await send(signed(seeded.originalSecret, body));
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain(BODY_WORDS);
    } finally {
      await ownerQuery(
        'drop trigger test_fail_run_insert on app.workflow_runs',
      );
      await ownerQuery('drop function app.test_fail_run_insert()');
    }
    const wrong = await send({
      ...signed(seeded.originalSecret, body),
      'x-pertexo-signature': `v1=${'0'.repeat(64)}`,
    });
    expect(wrong.statusCode).toBe(401);
    expect((await send(signed(seeded.originalSecret, body))).statusCode).toBe(
      202,
    );
    await application.close();

    const written = logs();
    // The failure was logged, so finding nothing below means something.
    expect(written).toContain('webhook.ingress_failed');
    expect(written).toContain('forced failure');
    for (const words of [
      BODY_WORDS,
      QUERY_WORDS,
      HEADER_WORDS,
      KEY_WORDS,
      seeded.endpointKey,
      seeded.originalSecret,
    ])
      expect(written).not.toContain(words);
  }, 60_000);
  it('answers a webhook still being set up with 409 and Retry-After: 5, and one already set up with no retry time', async () => {
    const seeded = await seedWebhook('setup-retry-after');
    const session = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      seeded.actorId,
    );
    const provision = () =>
      application.inject({
        method: 'POST',
        url: `/v1/workspaces/${seeded.workspaceId}/workflows/${seeded.workflowId}/triggers/${seeded.trigger.id}/webhook/provision`,
        headers: {
          cookie: session.cookieHeader,
          'x-csrf-token': session.csrf,
          'idempotency-key': randomUUID(),
        },
      });

    const provisioned = await provision();
    expect(provisioned.statusCode, provisioned.body).toBe(409);
    expect(provisioned.headers['retry-after']).toBeUndefined();

    await ownerQuery(
      "update app.workflow_triggers set status='pending' where id=$1",
      [seeded.trigger.id],
    );
    const settingUp = await provision();
    expect(settingUp.statusCode, settingUp.body).toBe(409);
    expect(settingUp.headers['retry-after']).toBe('5');
    expect(settingUp.json()).toMatchObject({ code: 'webhook.setting_up' });
    expect(apiProblemSchema.safeParse(settingUp.json()).success).toBe(true);
  });
});
