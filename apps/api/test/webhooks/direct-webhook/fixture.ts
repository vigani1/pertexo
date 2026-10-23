import { createWebhookTestEventStore } from '@pertexo/database/triggers';
import { WebhookTestEventService } from '../../../src/webhooks/test-events/service.js';

import { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';

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
import { expect, vi } from 'vitest';
import { createApiApplication } from '../../../src/app.js';
import { createInitialCheckpoint } from '@pertexo/execution';
import type { ApiConfig } from '../../../src/platform/config/api.js';
import {
  createApiIdentityRuntime,
  type ApiIdentityRuntime,
} from '../../../src/platform/identity/identity-runtime.module.js';
import { createCoreWorkflowAuthoringDatabase } from '../../../src/platform/workflow/workflow-runtime.module.js';
import { WebhookManagementService } from '../../../src/webhooks/management/service.js';

import { dropDisconnectedDatabase } from '../../support/disposable-database.js';
import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../../browser/harness/resource-owner.js';

import {
  sendBoundedWebhook,
  type BoundedWebhookResponse,
} from '../support/bounded-client.js';

export function recordBenchmarkOperation(startedAt: number): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION=${JSON.stringify({ name: 'webhook-admit', startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population: 1, boundary: 'authenticated webhook request through durable admission response' })}\n`,
  );
}

export const adminBaseUrl = process.env.DATABASE_ADMIN_URL;

export const migrationBaseUrl = process.env.DATABASE_MIGRATION_URL;

export const apiBaseUrl = process.env.DATABASE_URL;

export const requested = process.env.API_WEBHOOK_INTEGRATION === 'true';

export const enabled = requested;

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

type HttpResponse = BoundedWebhookResponse;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected secret material');
  return value;
}

export function expectProblem(
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

export let apiPool!: Pool;

let apiConfig!: ReturnType<typeof parseDatabaseConfig>;

export const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);

export let identity!: ReturnType<typeof createIdentityWorkspaceDatabase>;

export let identityRuntime!: ApiIdentityRuntime;

export let authoring!: ReturnType<typeof createCoreWorkflowAuthoringDatabase>;

let reconciliation!: ReturnType<
  typeof createWorkflowTriggerReconciliationDatabase
>;

export let webhookDatabase!: ReturnType<typeof createWebhookTriggerDatabase>;

let workspaceDatabase!: ReturnType<typeof createWorkspaceDatabase>;

export let encryption!: WebhookTriggerEnvelopeEncryption;

export let service!: WebhookManagementService;

export let testEvents!: ReturnType<typeof createWebhookTestEventStore>;

export let ingressDatabase!: WebhookTriggerDatabase;

export let application!: Awaited<ReturnType<typeof createApiApplication>>;

let fixtureOwner: FixtureResourceOwner | undefined;

export const consume = vi.fn<RedisRateLimitRuntime['consume']>();

export const verificationControl = { failVerification: false };

export let origin = '';

export let workspaceId = '';

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
        if (verificationControl.failVerification)
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

export async function seedWebhook(
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

export async function ownerQuery<Row extends QueryResultRow = QueryResultRow>(
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

export async function apiQuery<Row extends QueryResultRow = QueryResultRow>(
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

export async function durableCounts() {
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

export function withOneMoreDelivery(
  counts: Awaited<ReturnType<typeof durableCounts>>,
) {
  if (counts === undefined) throw new Error('Durable counts are missing');
  return { ...counts, deliveries: counts.deliveries + 1 };
}

export async function sendWebhook(
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

export async function prepareDirectWebhookHTTPIntegrationFixture() {
  fixtureOwner = await createFixture();
}

export async function closeDirectWebhookHTTPIntegrationFixture() {
  await fixtureOwner?.close();
}
