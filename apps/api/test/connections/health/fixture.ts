import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, expect } from 'vitest';
import { z } from 'zod';
import {
  connectionResponseSchema,
  connectionUsageResponseSchema,
} from '@pertexo/contracts';
import {
  ConnectionEnvelopeEncryption,
  createSlackClient,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createConnectionHealthSlackTransport } from '../../../../../infrastructure/testing/connection-health-slack-transport.mjs';
import { FixtureResourceOwner } from '../../browser/harness/resource-owner.js';
import { ownEditorBrowserProcess } from '../../browser/harness/process.js';
import { restartEditorBrowserWorker } from '../../browser/harness/worker-restart.js';
import { verifyConnectionHealthOwnership } from './ownership.js';
import {
  useBetterAuthRealApi,
  type Browser,
} from '../../support/better-auth/real-api.support.js';

function phase(child: ChildProcess, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exit);
      child.off('error', exit);
      if (error) reject(error);
      else resolve();
    };
    const message = (value: unknown) => {
      if (
        z.object({ phase: z.literal('health-startup-failed') }).safeParse(value)
          .success
      )
        finish(new Error('Owned health worker construction failed'));
      if (z.object({ phase: z.literal(expected) }).safeParse(value).success)
        finish();
    };
    const exit = () => {
      finish(new Error('Owned health worker failed startup'));
    };
    const timer = setTimeout(() => {
      finish(new Error(`Owned health worker startup deadline: ${expected}`));
    }, 20000);
    child.on('message', message);
    child.once('exit', exit);
    child.once('error', exit);
  });
}

const abandonedClaimSchema = z
  .object({
    phase: z.literal('health-publication-abandoned'),
    requestId: z.uuid(),
    success: z.literal(true),
    outboxEventId: z.uuid(),
    leaseToken: z.uuid(),
    leaseOwner: z.string().regex(/^health-abandoned-[0-9a-f-]{36}$/u),
    leaseExpiresAt: z.iso.datetime(),
    publishCalls: z.literal(0),
    releaseCalls: z.literal(0),
    markCalls: z.literal(0),
  })
  .strict();
function abandonPublication(child: ChildProcess, signal: AbortSignal) {
  const requestId = randomUUID();
  return new Promise<z.infer<typeof abandonedClaimSchema>>(
    (resolve, reject) => {
      let settled = false;
      const finish = (
        error?: Error,
        claim?: z.infer<typeof abandonedClaimSchema>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('message', message);
        child.off('error', failed);
        child.off('exit', failed);
        signal.removeEventListener('abort', failed);
        if (error !== undefined) reject(error);
        else if (claim !== undefined) resolve(claim);
      };
      const failed = () => {
        finish(new Error('Owned health abandonment channel failed'));
      };
      const message = (value: unknown) => {
        const envelope = z
          .object({
            phase: z.literal('health-publication-abandoned'),
            requestId: z.literal(requestId),
          })
          .safeParse(value);
        if (!envelope.success) return;
        const parsed = abandonedClaimSchema.safeParse(value);
        if (parsed.success) finish(undefined, parsed.data);
        else finish(new Error('Owned health abandonment failed'));
      };
      const timer = setTimeout(failed, 15_000);
      child.on('message', message);
      child.on('error', failed);
      child.on('exit', failed);
      signal.addEventListener('abort', failed, { once: true });
      if (signal.aborted || !child.connected) {
        failed();
        return;
      }
      try {
        child.send(
          { phase: 'abandon-health-publication', requestId },
          (error) => {
            if (error !== null) failed();
          },
        );
      } catch {
        failed();
      }
    },
  );
}

export function useConnectionHealthFixture(
  suite: string,
  options: Readonly<{
    webOrigin?: string;
    abandonPublicationBeforeRestart?: boolean;
    beforeClose?: () => Promise<void>;
    browserLifetime?: (path: string, instanceId: string) => void;
  }> = {},
) {
  const owner = new FixtureResourceOwner(),
    scope = new AbortController();
  const master = randomBytes(32);
  const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
    master,
    'connection',
  );
  owner.acquire('API envelope keys', keys, () => {
    keys.close();
  });
  const token = 'xoxb-owned-fixture-token-1',
    replacementToken = 'xoxb-owned-fixture-token-2';
  let controlOrigin = '',
    worker: ChildProcess,
    browser: Browser,
    workspaceId = '',
    connectionId = '',
    workflowId = '',
    actorId = '';
  let staleRun = '',
    rotationRun = '',
    sends = 0,
    nextResponse: 'hold' | 'reject' | 'healthy' = 'healthy';
  let commandStage = 'initializing';
  const held = new Set<ServerResponse>(),
    pending = new Set<Promise<void>>();
  const json = (response: ServerResponse, value: unknown) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify(value));
  };
  const control = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/api/auth.test') {
      json(response, { ok: true });
      return;
    }
    if (path === '/api/chat.postMessage') {
      sends++;
      const action = nextResponse;
      nextResponse = 'reject';
      if (action === 'hold') {
        held.add(response);
        response.once('close', () => held.delete(response));
        return;
      }
      json(
        response,
        action === 'healthy'
          ? { ok: true, channel: 'C123ABC', ts: '1710000000.000001' }
          : { ok: false, error: 'token_revoked' },
      );
      return;
    }
    if (request.method === 'GET' && path === '/connection-health-seed') {
      json(response, {
        workspaceId,
        connectionId,
        workflowId,
        token,
        replacementToken,
        cookies: [
          {
            name: 'pertexo_session',
            value: browser.session,
            url: options.webOrigin,
          },
          {
            name: 'pertexo_csrf',
            value: encodeURIComponent(browser.csrf),
            url: options.webOrigin,
          },
        ],
      });
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    if (path === '/browser-opened' || path === '/browser-disposed') {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 512) request.destroy();
      });
      request.on('end', () => {
        try {
          const parsed = z
            .object({ instanceId: z.uuid() })
            .strict()
            .parse(JSON.parse(body));
          options.browserLifetime?.(path, parsed.instanceId);
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
      return;
    }
    const command = Promise.resolve()
      .then(() => commandFor(path))
      .then(
        (value) => {
          json(response, value);
        },
        async () => {
          const runs = await api
            .database()
            .query<{ status: string }>(
              'select status from app.workflow_runs where workspace_id=$1',
              [workspaceId],
            );
          const attempts = await api
            .database()
            .query<{ status: string }>(
              'select status from app.node_attempts where workspace_id=$1',
              [workspaceId],
            );
          const outbox = await api
            .database()
            .query<{ job_name: string; published: boolean; failed: boolean }>(
              'select job_name,published_at is not null published,failed_at is not null failed from app.outbox_events where workspace_id=$1',
              [workspaceId],
            );
          console.info(
            'Owned health command diagnostics',
            JSON.stringify({
              stage: commandStage,
              providerCalls: sends,
              runs: runs.rows,
              attempts: attempts.rows,
              outbox: outbox.rows,
            }),
          );
          response
            .writeHead(500)
            .end('Owned connection health evidence failed');
        },
      );
    pending.add(command);
    void command.finally(() => pending.delete(command));
  });
  owner.acquire('controlled Slack server', control, async () => {
    for (const response of held) response.writeHead(503).end();
    await Promise.allSettled([...pending]);
    await new Promise<void>((resolve, reject) =>
      control.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  });
  beforeAll(async () => {
    await verifyConnectionHealthOwnership();
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(0, '127.0.0.1', resolve);
    });
    const address = control.address();
    if (address === null || typeof address === 'string')
      throw new Error('Owned health control absent');
    controlOrigin = `http://127.0.0.1:${String(address.port)}`;
    worker = fork(
      new URL(
        '../../../../worker/test/connections/health-worker-process.fixture.ts',
        import.meta.url,
      ),
      [],
      {
        cwd: new URL('../../../../worker/', import.meta.url),
        execArgv: ['--import', 'tsx'],
        env: process.env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: true,
      },
    );
    const lifetime = ownEditorBrowserProcess(worker, 'worker');
    owner.acquire('worker', worker, () => lifetime.close());
    worker.on('message', (value: unknown) => {
      const diagnostic = z
        .object({
          phase: z.enum([
            'health-handler-started',
            'health-handler-finished',
            'health-startup-failed',
          ]),
          outcome: z.enum(['completed', 'failed']).optional(),
          errorType: z
            .string()
            .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/u)
            .optional(),
          code: z
            .string()
            .regex(/^[A-Z0-9]{5}$/u)
            .optional(),
        })
        .safeParse(value);
      if (
        diagnostic.success &&
        (diagnostic.data.phase === 'health-startup-failed' ||
          diagnostic.data.outcome === 'failed')
      )
        console.error('Owned health worker failure', diagnostic.data);
      if (
        !z
          .object({ phase: z.literal('namespace-cleanup-request') })
          .safeParse(value).success
      )
        return;
      void verifyConnectionHealthOwnership().then(
        () =>
          worker.connected &&
          worker.send({ phase: 'namespace-cleanup-approved' }),
        () =>
          worker.connected &&
          worker.send({ phase: 'namespace-cleanup-denied' }),
      );
    });
    await phase(worker, 'namespace-ready');
  }, 30000);
  const redis = new URL(process.env.REDIS_URL ?? 'redis://invalid:1/0');
  redis.pathname = '/13';
  const api = useBetterAuthRealApi(suite, {
    ...(options.webOrigin === undefined
      ? {}
      : { publicWebOrigin: options.webOrigin }),
    redisUrl: redis.toString(),
    connections: {
      config: { kmsKeyReference: 'owned-health-fixture', region: 'us-east-1' },
      overrides: {
        encryption: { value: new ConnectionEnvelopeEncryption(keys) },
        clients: {
          slackFactory: () =>
            createSlackClient(
              createConnectionHealthSlackTransport(controlOrigin),
            ),
          http: {
            execute: () =>
              Promise.reject(new Error('HTTP outside health fixture')),
          },
          email: {
            sendNotification: () =>
              Promise.reject(new Error('Email outside health fixture')),
          },
        },
      },
    },
    afterMigration: async (databaseUrl) => {
      const ready = phase(worker, 'worker-ready');
      worker.send({
        workerUrl: databaseUrl(process.env.DATABASE_URL ?? ''),
        dispatcherUrl: databaseUrl(process.env.DATABASE_MAINTENANCE_URL ?? ''),
        apiUrl: databaseUrl(process.env.DATABASE_URL ?? ''),
        migrationUrl: databaseUrl(process.env.DATABASE_MIGRATION_URL ?? ''),
        connectionMasterKey: master.toString('hex'),
        controlOrigin,
      });
      await ready;
      master.fill(0);
    },
    beforeClose: async () => {
      scope.abort();
      for (const response of held) response.writeHead(503).end();
      await Promise.allSettled([...pending]);
      await options.beforeClose?.();
      await owner.close();
    },
    beforeDrop: verifyConnectionHealthOwnership,
  });

  async function wait<T>(
    read: () => Promise<T>,
    matches: (value: T) => boolean,
    timeoutMillis = 20000,
  ) {
    const deadline = Date.now() + timeoutMillis;
    for (;;) {
      scope.signal.throwIfAborted();
      const value = await read();
      if (matches(value)) return value;
      if (Date.now() > deadline)
        throw new Error('Owned health evidence deadline');
      await delay(50, undefined, { signal: scope.signal });
    }
  }
  async function readConnection() {
    const reply = await api.send(
      'GET',
      `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
      { browser },
    );
    expect(reply.statusCode, reply.payload).toBe(200);
    return connectionResponseSchema.parse(reply.json());
  }
  async function readRun(runId: string) {
    const reply = await api.send(
      'GET',
      `/v1/workspaces/${workspaceId}/runs/${runId}`,
      { browser },
    );
    expect(reply.statusCode, reply.payload).toBe(200);
    return reply.json<{ run: { status: string } }>().run.status;
  }
  async function startRun() {
    const reply = await api.send(
      'POST',
      `/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
      {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { input: {} },
      },
    );
    expect(reply.statusCode, reply.payload).toBe(202);
    return reply.json<{ run: { id: string } }>().run.id;
  }
  async function completeHeld(runId: string) {
    expect(held.size).toBe(1);
    for (const response of held)
      json(response, { ok: false, error: 'token_revoked' });
    await wait(
      () => readRun(runId),
      (status) => status === 'failed',
    );
    await wait(
      async () =>
        (
          await api.database().query<{ count: number }>(
            `select count(*)::int count from app.connection_health_observations observation
      join app.node_attempts attempt on attempt.workspace_id=observation.workspace_id and attempt.id=observation.attempt_id
      join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
      where observation.workspace_id=$1 and node.workflow_run_id=$2 and observation.applied_at is not null`,
            [workspaceId, runId],
          )
        ).rows[0]?.count ?? 0,
      (count) => count === 1,
    );
  }
  async function commandFor(path: string) {
    scope.signal.throwIfAborted();
    if (path === '/reject-run') {
      commandStage = 'reject-provider-outcome';
      nextResponse = 'reject';
      const runId = await startRun();
      await wait(
        () => readRun(runId),
        (status) => status === 'failed',
      );
      expect((await readConnection()).status).toBe('active');
      const evidence = await api
        .database()
        .query<{ count: number }>(
          `select count(*)::int count from app.connection_health_observations where workspace_id=$1 and applied_at is null`,
          [workspaceId],
        );
      expect(evidence.rows[0]?.count).toBe(1);
      const callsBeforeRestart = sends;
      const accepted = async () =>
        (
          await api.database().query<{ run: unknown; attempts: unknown }>(
            `select row_to_json(run) run,(select json_agg(attempt order by attempt.id)
        from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
        where attempt.workspace_id=$1 and node.workflow_run_id=run.id) attempts
        from app.workflow_runs run where run.workspace_id=$1 and run.id=$2`,
            [workspaceId, runId],
          )
        ).rows;
      const before = await accepted();
      const claim =
        options.abandonPublicationBeforeRestart === true
          ? await abandonPublication(worker, scope.signal)
          : undefined;
      const assertAbandoned = async () => {
        if (claim === undefined) return;
        const result = await api.database().query<{
          lease_token: string;
          lease_owner: string;
          future: boolean;
          publish_attempts: number;
          pending: boolean;
          observation_pending: boolean;
        }>(
          `select event.lease_token,event.lease_owner,event.lease_expires_at>clock_timestamp() future,
          event.publish_attempts,event.published_at is null and event.failed_at is null pending,
          observation.applied_at is null observation_pending
          from app.outbox_events event join app.connection_health_observations observation
          on observation.workspace_id=event.workspace_id and observation.id::text=event.payload->>'observationId'
          join app.node_attempts attempt on attempt.workspace_id=observation.workspace_id and attempt.id=observation.attempt_id
          join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
          where event.workspace_id=$1 and event.id=$2 and node.workflow_run_id=$3`,
          [workspaceId, claim.outboxEventId, runId],
        );
        expect(result.rows).toEqual([
          {
            lease_token: claim.leaseToken,
            lease_owner: claim.leaseOwner,
            future: true,
            publish_attempts: 1,
            pending: true,
            observation_pending: true,
          },
        ]);
        expect((await readConnection()).status).toBe('active');
        expect(sends).toBe(callsBeforeRestart);
      };
      await assertAbandoned();
      commandStage = 'restart-before-health-delivery';
      await restartEditorBrowserWorker(
        worker as Parameters<typeof restartEditorBrowserWorker>[0],
        randomUUID(),
        scope.signal,
      );
      await assertAbandoned();
      await wait(
        readConnection,
        (connection) => connection.status === 'reauthorization_required',
        claim === undefined ? 20000 : 45000,
      );
      if (claim !== undefined) {
        const recovered = await api.database().query<{
          published_after_expiry: boolean;
          publish_attempts: number;
          unleased: boolean;
          applied: boolean;
          receipts: number;
          transitions: number;
        }>(
          `select event.published_at >= $3::timestamptz published_after_expiry,event.publish_attempts,
          event.lease_token is null and event.lease_owner is null unleased,observation.applied_at is not null applied,
          (select count(*)::int from app.inbox_receipts where workspace_id=$1 and consumer_name='connection-health-worker'
          and message_id=event.id and completed_at is not null) receipts,
          (select count(*)::int from app.connection_events where workspace_id=$1 and connection_id=$4
          and event_type='connection.reauthorization_required' and metadata->>'source'='run') transitions
          from app.outbox_events event join app.connection_health_observations observation
          on observation.workspace_id=event.workspace_id and observation.id::text=event.payload->>'observationId'
          where event.workspace_id=$1 and event.id=$2`,
          [
            workspaceId,
            claim.outboxEventId,
            claim.leaseExpiresAt,
            connectionId,
          ],
        );
        expect(recovered.rows).toEqual([
          {
            published_after_expiry: true,
            publish_attempts: 2,
            unleased: true,
            applied: true,
            receipts: 1,
            transitions: 1,
          },
        ]);
        expect(await accepted()).toEqual(before);
      }
      expect(sends).toBe(callsBeforeRestart);
      return {
        restarted: true,
        abandonedPublicationRecovered: claim !== undefined,
        providerCalls: sends,
      };
    }
    if (path === '/hold-and-reject') {
      nextResponse = 'hold';
      staleRun = await startRun();
      await wait(
        () => Promise.resolve(held.size),
        (count) => count === 1,
      );
      nextResponse = 'reject';
      const runId = await startRun();
      await wait(
        () => readRun(runId),
        (status) => status === 'failed',
      );
      await wait(
        readConnection,
        (connection) => connection.status === 'reauthorization_required',
      );
      return { held: true };
    }
    if (path === '/release-stale-after-test') {
      expect((await readConnection()).status).toBe('active');
      await completeHeld(staleRun);
      expect((await readConnection()).status).toBe('active');
      return { healthy: true };
    }
    if (path === '/hold-before-rotation') {
      nextResponse = 'hold';
      rotationRun = await startRun();
      await wait(
        () => Promise.resolve(held.size),
        (count) => count === 1,
      );
      return { held: true };
    }
    if (path === '/release-stale-after-rotation') {
      await completeHeld(rotationRun);
      const connection = await readConnection();
      expect(connection.status).toBe('active');
      expect(connection.health.lastHealthyAt).toBeNull();
      return { unknown: true };
    }
    if (path === '/deny-membership') {
      await api
        .database()
        .query(
          "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
          [workspaceId, actorId],
        );
      return { denied: true };
    }
    throw new Error('Unknown health command');
  }
  async function seed() {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    browser = await api.signIn(email);
    const created = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Health qualification',
        slug: `health-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(created.statusCode, created.payload).toBe(201);
    workspaceId = created.json<{ id: string }>().id;
    actorId =
      (
        await api
          .database()
          .query<{ id: string }>('select id from app.users where email=$1', [
            email,
          ])
      ).rows[0]?.id ?? '';
    const connection = await api.send(
      'POST',
      `/v1/workspaces/${workspaceId}/connections`,
      {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          providerKey: 'slack',
          name: 'Incident Slack',
          credential: {
            type: 'slack_bot_token',
            botToken: token,
          },
        },
      },
    );
    expect(connection.statusCode, connection.payload).toBe(201);
    connectionId = connectionResponseSchema.parse(connection.json()).id;
    const workflow = await api.send(
      'POST',
      `/v1/workspaces/${workspaceId}/workflows`,
      {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Health sender' },
      },
    );
    expect(workflow.statusCode, workflow.payload).toBe(201);
    workflowId = workflow.json<{ workflow: { id: string } }>().workflow.id;
    const route = `/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
      nodeId = randomUUID();
    for (let version = 1; version <= 2; version++) {
      const draft = await api.send('GET', `${route}/draft`, { browser });
      const saved = await api.send('PUT', `${route}/draft`, {
        browser,
        headers: { 'if-match': String(draft.headers.etag) },
        payload: {
          graph: {
            nodes: [
              {
                id: nodeId,
                definition: { key: 'slack.send_message', version: 1 },
                label: 'Controlled Slack send',
                position: { x: version, y: 0 },
                configVersion: 1,
                config: { timeoutMillis: 30000 },
                inputMappings: {
                  channelId: { kind: 'literal', value: 'C123ABC' },
                  text: {
                    kind: 'literal',
                    value: `Owned health ${String(version)}`,
                  },
                },
                connectionRefs: { slack_bot_token: connectionId },
              },
            ],
            edges: [],
            settings: {},
          },
        },
      });
      expect(saved.statusCode, saved.payload).toBe(200);
      const published = await api.send('POST', `${route}/publish`, {
        browser,
        headers: {
          'if-match': String(saved.headers.etag),
          'idempotency-key': randomUUID(),
        },
      });
      expect(published.statusCode, published.payload).toBe(200);
    }
    const usage = await api.send(
      'GET',
      `/v1/workspaces/${workspaceId}/connections/${connectionId}/usage`,
      { browser },
    );
    expect(
      connectionUsageResponseSchema.parse(usage.json()).items,
    ).toHaveLength(2);
    return { workspaceId, connectionId, workflowId, browser };
  }
  return {
    api,
    seed,
    readConnection,
    commandFor,
    get controlOrigin() {
      return controlOrigin;
    },
    get providerCalls() {
      return sends;
    },
  };
}
