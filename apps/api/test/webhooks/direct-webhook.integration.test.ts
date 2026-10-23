import { createWebhookTestEventStore } from '@pertexo/database/triggers';
import { WebhookTestEventService } from '../../src/webhooks/test-events/service.js';
import { qualifyWebhookTestEvents } from './test-events/qualify.js';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import { qualifyWebhookResponseWaiting } from './responses/qualify.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  createIdentityWorkspaceDatabase,
  createWebhookTriggerDatabase,
  createWorkflowTriggerReconciliationDatabase,
  createWorkspaceDatabase,
  migrateDatabase,
  parseDatabaseConfig,
  type WebhookTriggerDatabase,
} from '@pertexo/database/testing';
import {
  WebhookTriggerEnvelopeEncryption,
  type WebhookEnvelopeKeyProvider,
} from '@pertexo/integrations/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import { createInitialCheckpoint } from '@pertexo/execution';
import type { ApiConfig } from '../../src/platform/config/api.js';
import {
  createApiIdentityRuntime,
  type ApiIdentityRuntime,
} from '../../src/platform/identity/identity-runtime.module.js';
import { createCoreWorkflowAuthoringDatabase } from '../../src/platform/workflow/workflow-runtime.module.js';
import { WebhookManagementService } from '../../src/webhooks/management/service.js';
import { issueBrowserSession } from './support/browser-session.fixture.js';
import { dropDisconnectedDatabase } from '../support/disposable-database.js';
import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../browser/harness/resource-owner.js';
import { assertIntegrationGateConfigured } from '../support/integration-gate.js';
import {
  sendBoundedWebhook,
  type BoundedWebhookResponse,
} from './support/bounded-client.js';

function recordBenchmarkOperation(startedAt: number): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION=${JSON.stringify({ name: 'webhook-admit', startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population: 1, boundary: 'authenticated webhook request through durable admission response' })}\n`,
  );
}

const adminBaseUrl = process.env.DATABASE_ADMIN_URL;
const migrationBaseUrl = process.env.DATABASE_MIGRATION_URL;
const apiBaseUrl = process.env.DATABASE_URL;
const requested = process.env.API_WEBHOOK_INTEGRATION === 'true';
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
const enabled = requested;
const runnerOwnsDatabase = process.env.PERTEXO_Q11_RUNNER_OWNS_DATABASE === '1';
const databaseName = (() => {
  if (!runnerOwnsDatabase)
    return `pertexo_test_api_webhook_${randomUUID().replaceAll('-', '')}`;
  const value = process.env.PERTEXO_Q11_DATABASE_NAME;
  if (!value) throw new Error('Q11 runner-owned database name is required');
  return value;
})();
const databaseUrl = (base: string): string => {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
const configuredDatabaseUrl = (base: string | undefined): string =>
  databaseUrl(base ?? 'postgresql://integration-disabled@127.0.0.1:1/unused');
const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const migrationRole =
  process.env.POSTGRES_MIGRATION_USER ?? 'pertexo_migration';
const appRole = process.env.POSTGRES_APP_USER ?? 'pertexo_app';
const maintenanceRole =
  process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance';

const logger: StructuredLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
};
const telemetry: TelemetryLifecycle = {
  enabled: false,
  started: false,
  start: () => undefined,
  shutdown: () => Promise.resolve(),
};

class DeterministicEnvelopeKeys implements WebhookEnvelopeKeyProvider {
  readonly #master = new Uint8Array(32).fill(0x6d);

  public generateDataKey(
    context: Parameters<WebhookEnvelopeKeyProvider['generateDataKey']>[0],
  ) {
    const plaintextKey = this.plaintextKey(context);
    return Promise.resolve({
      plaintextKey,
      encryptedDataKey: new Uint8Array(plaintextKey),
      keyReference: 'in-process://webhook-integration-v1',
    });
  }

  public decryptDataKey(encryptedDataKey: Uint8Array, keyReference: string) {
    if (
      keyReference !== 'in-process://webhook-integration-v1' ||
      encryptedDataKey.byteLength !== 32
    )
      return Promise.reject(new Error('Envelope key context mismatch'));
    return Promise.resolve(new Uint8Array(encryptedDataKey));
  }

  private plaintextKey(
    context: Parameters<WebhookEnvelopeKeyProvider['generateDataKey']>[0],
  ) {
    return new Uint8Array(
      createHmac('sha256', this.#master).update(contextBytes(context)).digest(),
    );
  }
}

function contextBytes(context: {
  workspaceId: string;
  triggerId: string;
  secretVersionId: string;
}): string {
  return `${context.workspaceId}\0${context.triggerId}\0${context.secretVersionId}`;
}

describe.runIf(enabled)('direct webhook HTTP integration', () => {
  beforeAll(prepareDirectWebhookHTTPIntegrationFixture, 120_000);

  afterAll(closeDirectWebhookHTTPIntegrationFixture, 30_000);
  registerCapturesOneRealTestEventBefore();

  registerConfiguresModesThroughAuthenticatedHTTPQualifies();

  registerProvesAtomicAcceptanceExactReplayReplay();

  registerReadsResumedRunRunningThroughAuthenticated();

  registerReturnsNoEndpointCredentialOnCompleted();
});

type HttpResponse = BoundedWebhookResponse;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected secret material');
  return value;
}

function expectProblem(
  response: HttpResponse,
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.json).toMatchObject({ status, code });
}

function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\0'))
    throw new Error('PostgreSQL role or database identifier is invalid');
  return `"${value.replaceAll('"', '""')}"`;
}

let admin!: Pool;

let owner!: Pool;

let apiPool!: Pool;

let apiConfig!: ReturnType<typeof parseDatabaseConfig>;

const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);

let identity!: ReturnType<typeof createIdentityWorkspaceDatabase>;

let identityRuntime!: ApiIdentityRuntime;

let authoring!: ReturnType<typeof createCoreWorkflowAuthoringDatabase>;

let reconciliation!: ReturnType<
  typeof createWorkflowTriggerReconciliationDatabase
>;

let webhookDatabase!: ReturnType<typeof createWebhookTriggerDatabase>;

let workspaceDatabase!: ReturnType<typeof createWorkspaceDatabase>;

let encryption!: WebhookTriggerEnvelopeEncryption;

let service!: WebhookManagementService;

let testEvents!: ReturnType<typeof createWebhookTestEventStore>;

let ingressDatabase!: WebhookTriggerDatabase;

let application!: Awaited<ReturnType<typeof createApiApplication>>;

let fixtureOwner: FixtureResourceOwner | undefined;

const consume = vi.fn<RedisRateLimitRuntime['consume']>();

let failVerification = false;

let origin = '';

let workspaceId = '';

async function createFixture(): Promise<FixtureResourceOwner> {
  const resources = new FixtureResourceOwner();
  try {
    admin = resources.acquire(
      'admin pool',
      new Pool({ connectionString: adminBaseUrl, max: 1 }),
      (pool) => pool.end(),
    );
    if (!runnerOwnsDatabase) {
      await admin.query(
        `create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(ownerRole)}`,
      );
      resources.acquire(
        'disposable database',
        { name: databaseName },
        ({ name }) => dropDisconnectedDatabase(admin, name),
      );
      await admin.query(
        `revoke all on database ${quoteIdentifier(databaseName)} from public`,
      );
      await admin.query(
        `grant connect on database ${quoteIdentifier(databaseName)} to ${[
          migrationRole,
          appRole,
          maintenanceRole,
        ]
          .map(quoteIdentifier)
          .join(', ')}`,
      );
    }
    owner = resources.acquire(
      'owner pool',
      new Pool({
        connectionString: configuredDatabaseUrl(migrationBaseUrl),
        max: 1,
      }),
      (pool) => pool.end(),
    );
    apiPool = resources.acquire(
      'API assertion pool',
      new Pool({
        connectionString: configuredDatabaseUrl(apiBaseUrl),
        max: 1,
      }),
      (pool) => pool.end(),
    );
    apiConfig = parseDatabaseConfig({
      connectionString: configuredDatabaseUrl(apiBaseUrl),
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 2_000,
      max: 12,
      ownerRole,
    });
    await migrateDatabase({
      connectionString: configuredDatabaseUrl(migrationBaseUrl),
      ownerRole,
      appRole,
      maintenanceRole,
    });
    identity = resources.acquire(
      'identity database',
      createIdentityWorkspaceDatabase(apiConfig),
      (database) => database.close(),
    );
    identityRuntime = resources.acquire(
      'identity runtime',
      await createApiIdentityRuntime(
        {
          publicWebOrigin: 'https://app.example.test',
          session: {
            ttlMillis: 60_000,
            secureCookie: false,
            sameSite: 'lax',
          },
          betterAuth: {
            secret: 'webhook-integration-secret-with-32-plus-characters',
            mailMode: 'local',
            providers: {},
          },
        },
        apiConfig,
        { persistence: { database: identity } },
      ),
      (runtime) => runtime.close(),
    );
    resources.transfer(identity);
    authoring = resources.acquire(
      'workflow authoring database',
      createCoreWorkflowAuthoringDatabase(apiConfig),
      (database) => database.close(),
    );
    reconciliation = resources.acquire(
      'trigger reconciliation database',
      createWorkflowTriggerReconciliationDatabase(apiConfig),
      (database) => database.close(),
    );
    webhookDatabase = resources.acquire(
      'webhook database',
      createWebhookTriggerDatabase(apiConfig),
      (database) => database.close(),
    );
    workspaceDatabase = resources.acquire(
      'workspace database',
      createWorkspaceDatabase(apiConfig),
      (database) => database.close(),
    );
    encryption = new WebhookTriggerEnvelopeEncryption(
      new DeterministicEnvelopeKeys(),
    );
    service = new WebhookManagementService(webhookDatabase, encryption);
    testEvents = resources.acquire(
      'test event store',
      createWebhookTestEventStore(apiConfig),
      (store) => store.close(),
    );
    ingressDatabase = {
      configureAuthentication: (input) =>
        webhookDatabase.configureAuthentication(input),
      readResponse: (input) => webhookDatabase.readResponse(input),
      provision: (input) => webhookDatabase.provision(input),
      rotateEndpoint: (input) => webhookDatabase.rotateEndpoint(input),
      rotateSecret: (input) => webhookDatabase.rotateSecret(input),
      getHealth: (input) => webhookDatabase.getHealth(input),
      resolveVerification: async (endpointKeyHash) => {
        if (failVerification)
          throw new Error('forced webhook verification outage');
        return webhookDatabase.resolveVerification(endpointKeyHash);
      },
      consumeIngressLimit: (endpointKeyHash) =>
        webhookDatabase.consumeIngressLimit(endpointKeyHash),
      acceptVerifiedDelivery: (input) =>
        webhookDatabase.acceptVerifiedDelivery(input),
      listDeliveries: (input) => webhookDatabase.listDeliveries(input),
      recordRejectedDelivery: (input) =>
        webhookDatabase.recordRejectedDelivery(input),
      close: () => Promise.resolve(),
    };
    const config: ApiConfig = {
      codeSettings: DEFAULT_CODE_SETTINGS,
      database: apiConfig,
      host: '127.0.0.1',
      nodeEnv: 'test',
      observability: {
        serviceName: 'pertexo-api-webhook-integration',
        serviceVersion: 'test',
        environment: 'test',
        logLevel: 'silent',
        otlpHeaders: {},
      },
      port: 3000,
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
    };
    const rateLimiter = resources.acquire(
      'rate limiter',
      new RedisRateLimitRuntime(config.redisUrl),
      (value) => value.close(),
    );
    consume.mockImplementation((decision) => rateLimiter.consume(decision));
    application = resources.acquire(
      'API application',
      await createApiApplication(config, {
        database: workspaceDatabase,
        rateLimitConsumer: { consume },
        identityRuntime,
        webhookRuntime: {
          service,
          testService: new WebhookTestEventService(testEvents, encryption),
          ingress: {
            database: ingressDatabase,
            testEvents,
            encryption,
            checkpointFactory: (projection) =>
              createInitialCheckpoint(projection, { catalog }),
          },
          close: () => Promise.resolve(),
        },
        logger,
        telemetry,
      }),
      (value) => value.close(),
    );
    await application.listen(0, '127.0.0.1');
    const address = application.getHttpServer().address();
    if (address === null || typeof address === 'string')
      throw new Error('Webhook HTTP listener address is unavailable');
    origin = `http://127.0.0.1:${String(address.port)}`;
    return resources;
  } catch (error: unknown) {
    return rethrowFixtureSetupFailure(resources, error);
  }
}

async function seedWebhook(
  label: string,
  responseConfig: Record<string, unknown> = {},
) {
  const actorId = randomUUID();
  workspaceId = randomUUID();
  await identity.createUser({
    id: actorId,
    email: `webhook-http-${actorId}@example.test`,
    displayName: `Webhook HTTP integration ${label}`,
  });
  await identity.createWorkspaceWithOwner({
    id: workspaceId,
    name: `Webhook HTTP integration ${label}`,
    slug: `webhook-http-${actorId}`,
    ownerUserId: actorId,
    idempotencyKey: `webhook-http-${actorId}`,
  });

  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    name: 'Direct webhook gate',
    emptyGraph: { settings: {}, nodes: [], edges: [] },
    idempotencyKey: `direct-webhook-create-${label}`,
  });
  const graph = {
    settings: {},
    nodes: [
      {
        id: 'webhook',
        definition: { key: 'core.webhook', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: responseConfig,
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
  };
  const draft = await authoring.saveDraft({
    actorId,
    workspaceId,
    workflowId: created.workflowId,
    representationTag: workflowDraftRepresentationTag({
      workflowId: created.workflowId,
      revision: created.draft.revision,
      graph: created.draft.graphJson,
      compatibilityFingerprint: created.draft.compatibility.fingerprint,
    }),
    expectedRevision: 1,
    graphJson: graph,
  });
  const published = await authoring.publishWorkflow({
    actorId,
    workspaceId,
    workflowId: created.workflowId,
    representationTag: workflowDraftRepresentationTag({
      workflowId: created.workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: draft.compatibility.fingerprint,
    }),
    idempotencyKey: `direct-webhook-publish-${label}`,
    requestHash: sha256(`direct-webhook-publish-${label}`),
  });
  const publication = await ownerQuery<{
    id: string;
    payload_checksum: string;
  }>(
    `select id,payload_checksum from app.outbox_events
        where workspace_id=$1 and aggregate_id=$2
          and job_name='reconcile-workflow-triggers'`,
    [workspaceId, created.workflowId],
  );
  const publicationRow = publication.rows[0];
  if (publicationRow === undefined)
    throw new Error('Webhook publication outbox is unavailable');
  const health = await reconciliation.reconcile({
    workspaceId,
    workflowId: created.workflowId,
    publishedVersionId: published.version.id,
    outboxEventId: publicationRow.id,
    delivery: {
      outboxEventId: publicationRow.id,
      payloadChecksum: publicationRow.payload_checksum,
    },
  });
  expect(health).toMatchObject([
    { kind: 'webhook', nodeId: 'webhook', status: 'configuration_required' },
  ]);
  const trigger = health[0];
  if (trigger === undefined) throw new Error('Webhook trigger is unavailable');
  const provisioned = await service.provision({
    workspaceId,
    workflowId: created.workflowId,
    actorId,
    triggerId: trigger.id,
    idempotencyKey: `direct-webhook-provision-${label}`,
  });
  expect(provisioned.trigger).toMatchObject({
    status: 'active',
    endpointReady: true,
  });
  expect(provisioned.endpointKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(provisioned.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const endpointKey = requireString(provisioned.endpointKey);
  const originalSecret = requireString(provisioned.signingSecret);
  return {
    workspaceId,
    actorId,
    endpointKey,
    originalSecret,
    provisioned,
    trigger,
    workflowId: created.workflowId,
  };
}

async function ownerQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${quoteIdentifier(ownerRole)}`);
    if (workspaceId !== '')
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
    const result = await client.query<Row>(statement, parameters);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function apiQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await apiPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await client.query<Row>(statement, parameters);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function durableCounts() {
  const result = await apiQuery<{
    deliveries: number;
    replay: number;
    runs: number;
  }>(
    `select
        (select count(*)::int from app.webhook_trigger_deliveries where workspace_id=$1) deliveries,
        (select count(*)::int from app.webhook_trigger_replay_records where workspace_id=$1) replay,
        (select count(*)::int from app.workflow_runs where workspace_id=$1) runs`,
    [workspaceId],
  );
  return result.rows[0];
}

function withOneMoreDelivery(
  counts: Awaited<ReturnType<typeof durableCounts>>,
) {
  if (counts === undefined) throw new Error('Durable counts are missing');
  return { ...counts, deliveries: counts.deliveries + 1 };
}

async function sendWebhook(
  endpointKey: string,
  secret: string,
  rawBody: Buffer,
  idempotencyKey: string,
): Promise<HttpResponse> {
  return sendBoundedWebhook({
    endpointKey,
    idempotencyKey,
    origin,
    rawBody,
    secret,
  });
}

async function prepareDirectWebhookHTTPIntegrationFixture() {
  fixtureOwner = await createFixture();
}

async function closeDirectWebhookHTTPIntegrationFixture() {
  await fixtureOwner?.close();
}

function registerCapturesOneRealTestEventBefore(): void {
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
      },
      seed: seedWebhook,
      query: ownerQuery,
    });
  }, 20_000);
}

function registerConfiguresModesThroughAuthenticatedHTTPQualifies(): void {
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
       where endpoint.trigger_id=$1`,
      [seeded.trigger.id],
    );
    expect(allowance.rows[0]?.request_count).toBe(6);
  });
}

function registerProvesAtomicAcceptanceExactReplayReplay(): void {
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
}

function registerReadsResumedRunRunningThroughAuthenticated(): void {
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
        where workspace_id=$1 and trigger_id=$2 returning id`,
      [workspaceId, trigger.id],
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
    failVerification = true;
    try {
      const unavailable = await sendWebhook(
        endpointKey,
        originalSecret,
        Buffer.from('{"verification-adapter":"unavailable"}'),
        'verification-adapter-unavailable',
      );
      expectProblem(unavailable, 503, 'webhook.unavailable');
    } finally {
      failVerification = false;
    }
  }, 60_000);
}

function registerReturnsNoEndpointCredentialOnCompleted(): void {
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
}
