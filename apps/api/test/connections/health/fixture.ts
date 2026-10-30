import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, expect } from 'vitest';
import { z } from 'zod';
import { connectionResponseSchema } from '@pertexo/contracts';
import {
  ConnectionEnvelopeEncryption,
  createSlackClient,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createConnectionHealthSlackTransport } from '../../../../../infrastructure/testing/connection-health-slack-transport.mjs';
import { FixtureResourceOwner } from '../../browser/harness/resource-owner.js';
import { ownEditorBrowserProcess } from '../../browser/harness/process.js';

import { verifyConnectionHealthOwnership } from './ownership.js';
import {
  useBetterAuthRealApi,
  type Browser,
} from '../../support/better-auth/real-api.support.js';
import type {
  ConnectionHealthFixtureOptions,
  ConnectionHealthFixtureState,
} from './fixture/contract.js';
import { phase } from './fixture/process.js';
import { executeConnectionHealthCommand } from './fixture/commands.js';
import { createConnectionHealthControl } from './fixture/server.js';
import { seedConnectionHealthFixture } from './fixture/seed.js';

export function useConnectionHealthFixture(
  suite: string,
  options: ConnectionHealthFixtureOptions = {},
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
  const state: ConnectionHealthFixtureState = {
    get worker() {
      return worker;
    },
    set worker(value: ChildProcess) {
      worker = value;
    },
    get browser() {
      return browser;
    },
    set browser(value: Browser) {
      browser = value;
    },
    get workspaceId() {
      return workspaceId;
    },
    set workspaceId(value: string) {
      workspaceId = value;
    },
    get connectionId() {
      return connectionId;
    },
    set connectionId(value: string) {
      connectionId = value;
    },
    get workflowId() {
      return workflowId;
    },
    set workflowId(value: string) {
      workflowId = value;
    },
    get actorId() {
      return actorId;
    },
    set actorId(value: string) {
      actorId = value;
    },
    get staleRun() {
      return staleRun;
    },
    set staleRun(value: string) {
      staleRun = value;
    },
    get rotationRun() {
      return rotationRun;
    },
    set rotationRun(value: string) {
      rotationRun = value;
    },
    get sends() {
      return sends;
    },
    set sends(value: number) {
      sends = value;
    },
    get nextResponse() {
      return nextResponse;
    },
    set nextResponse(value: 'hold' | 'reject' | 'healthy') {
      nextResponse = value;
    },
    get commandStage() {
      return commandStage;
    },
    set commandStage(value: string) {
      commandStage = value;
    },
  };
  const control = createConnectionHealthControl({
    state,
    held,
    pending,
    json,
    options,
    commandFor,
    readApi: () => api,
    token,
    replacementToken,
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
      // The control origin is known only once the worker has started.
      services: () => ({
        encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
        slack: createSlackClient(
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
      }),
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
  function commandFor(path: string) {
    return executeConnectionHealthCommand(
      {
        api,
        state,
        options,
        scope,
        held,
        wait,
        readConnection,
        readRun,
        startRun,
        completeHeld,
      },
      path,
    );
  }
  const seed = () => seedConnectionHealthFixture({ api, token, state });
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
