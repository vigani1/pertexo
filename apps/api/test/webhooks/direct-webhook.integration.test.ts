import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
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
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
} from '@pertexo/node-catalog';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/graph';
import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import { createInitialWorkflowCheckpoint } from '../../src/executions/index.js';
import { DatabaseIdentityWorkspaceAdapter } from '../../src/identity-workspace/index.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import { createCoreWorkflowAuthoringDatabase } from '../../src/platform/workflow/workflow-runtime.module.js';
import { WebhookManagementService } from '../../src/webhooks/service.js';
import { dropDisconnectedDatabase } from '../support/disposable-database.js';
import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../support/fixture-resource-owner.js';
import { assertIntegrationGateConfigured } from '../support/integration-gate.js';
import {
  sendBoundedWebhook,
  type BoundedWebhookResponse,
} from './bounded-webhook-client.js';

function recordBenchmarkOperation(startedAt: number): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION_V2=${JSON.stringify({ schemaVersion: 2, name: 'webhook-admit', startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population: 1, boundary: 'authenticated webhook request through durable admission response' })}\n`,
  );
}

const adminBaseUrl = process.env.DATABASE_ADMIN_URL;
const migrationBaseUrl = process.env.DATABASE_MIGRATION_URL;
const apiBaseUrl = process.env.DATABASE_API_URL;
const workerBaseUrl = process.env.DATABASE_WORKER_URL;
const requested = process.env.API_WEBHOOK_INTEGRATION === 'true';
assertIntegrationGateConfigured({
  name: 'direct webhook HTTP integration',
  requested,
  required: {
    DATABASE_ADMIN_URL: adminBaseUrl,
    DATABASE_MIGRATION_URL: migrationBaseUrl,
    DATABASE_API_URL: apiBaseUrl,
    DATABASE_WORKER_URL: workerBaseUrl,
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
const apiRole = process.env.POSTGRES_API_RUNTIME_USER ?? 'pertexo_api';
const workerRole = process.env.POSTGRES_WORKER_RUNTIME_USER ?? 'pertexo_worker';
const dispatcherRole =
  process.env.POSTGRES_DISPATCHER_USER ?? 'pertexo_dispatcher';

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
  let admin!: Pool;
  let owner!: Pool;
  let apiPool!: Pool;
  let apiConfig!: ReturnType<typeof parseDatabaseConfig>;
  let releaseSupport!: ReturnType<
    typeof createExecutableCompatibilityReleaseSupport
  >;
  let releaseHistory!: ReturnType<
    typeof createExecutableCompatibilityReleaseHistory
  >;
  let identity!: ReturnType<typeof createIdentityWorkspaceDatabase>;
  let authoring!: ReturnType<typeof createCoreWorkflowAuthoringDatabase>;
  let reconciliation!: ReturnType<
    typeof createWorkflowTriggerReconciliationDatabase
  >;
  let webhookDatabase!: ReturnType<typeof createWebhookTriggerDatabase>;
  let workspaceDatabase!: ReturnType<typeof createWorkspaceDatabase>;
  let encryption!: WebhookTriggerEnvelopeEncryption;
  let service!: WebhookManagementService;
  let ingressDatabase!: WebhookTriggerDatabase;
  let application!: Awaited<ReturnType<typeof createApiApplication>>;
  let fixtureOwner: FixtureResourceOwner | undefined;
  let failVerification = false;
  let origin = '';
  let workspaceId = '';

  beforeAll(async () => {
    fixtureOwner = await createFixture();
  }, 120_000);

  afterAll(async () => {
    await fixtureOwner?.close();
  }, 30_000);

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
            apiRole,
            workerRole,
            dispatcherRole,
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
        workerRuntimeRole: workerRole,
      });
      releaseSupport = createExecutableCompatibilityReleaseSupport(
        platformRegistryReleaseSupport('webhook_activation').map(
          composeExecutableCompatibilityRelease,
        ),
      );
      releaseHistory = createExecutableCompatibilityReleaseHistory(
        platformExecutableRegistryHistory('webhook_activation').map(
          composeExecutableCompatibilityRelease,
        ),
      );
      await migrateDatabase({
        connectionString: configuredDatabaseUrl(migrationBaseUrl),
        ownerRole,
        apiRuntimeRole: apiRole,
        workerRuntimeRole: workerRole,
        dispatcherRole,
        maintenanceRole: 'pertexo_maintenance',
        lifecycleCommandRole: 'pertexo_lifecycle_command',
        operatorRole: 'pertexo_operator',
      });
      await activateWebhookRelease();
      identity = resources.acquire(
        'identity database',
        createIdentityWorkspaceDatabase(apiConfig),
        (database) => database.close(),
      );
      const identityPersistence = new DatabaseIdentityWorkspaceAdapter(
        identity,
      );
      const identityRuntime = Object.freeze({
        dependencies: Object.freeze({
          config: Object.freeze({
            oidc: Object.freeze({
              issuer: 'https://identity.example.test',
              authorizationEndpoint: 'https://identity.example.test/authorize',
              clientId: 'webhook-integration',
              redirectUri: 'https://api.example.test/v1/auth/oidc/callback',
              scopes: Object.freeze(['openid']),
              transactionTtlMillis: 300_000,
            }),
          }),
          provider: Object.freeze({
            authorizationUrl: () => 'https://identity.example.test/authorize',
            exchangeCode: () => Promise.reject(new Error('not used')),
          }),
          transactions: Object.freeze({
            create: () => Promise.resolve(),
            consume: () => Promise.resolve(undefined),
          }),
          persistence: identityPersistence,
          authorization: identityPersistence,
        }),
        close: () => Promise.resolve(),
      }) satisfies ApiIdentityRuntime;
      authoring = resources.acquire(
        'workflow authoring database',
        createCoreWorkflowAuthoringDatabase(apiConfig, 'webhook_activation'),
        (database) => database.close(),
      );
      reconciliation = resources.acquire(
        'trigger reconciliation database',
        createWorkflowTriggerReconciliationDatabase(apiConfig),
        (database) => database.close(),
      );
      webhookDatabase = resources.acquire(
        'webhook database',
        createWebhookTriggerDatabase(apiConfig, releaseSupport.descriptions),
        (database) => database.close(),
      );
      workspaceDatabase = resources.acquire(
        'workspace database',
        createWorkspaceDatabase(apiConfig, {
          compatibilityReleases: releaseSupport.descriptions,
        }),
        (database) => database.close(),
      );
      encryption = new WebhookTriggerEnvelopeEncryption(
        new DeterministicEnvelopeKeys(),
      );
      service = new WebhookManagementService(webhookDatabase, encryption);
      ingressDatabase = {
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
        database: apiConfig,
        host: '127.0.0.1',
        nodeEnv: 'test',
        nodeCompatibilityCohort: 'webhook_activation',
        observability: {
          serviceName: 'pertexo-api-webhook-integration',
          serviceVersion: 'test',
          environment: 'test',
          logLevel: 'silent',
          otlpHeaders: {},
        },
        port: 3000,
        redisUrl: 'redis://localhost:6379/0',
      };
      application = resources.acquire(
        'API application',
        await createApiApplication(config, {
          database: workspaceDatabase,
          identityRuntime,
          webhookRuntime: {
            service,
            ingress: {
              database: ingressDatabase,
              encryption,
              checkpointFactory: (projection, currentRelease) =>
                createInitialWorkflowCheckpoint(
                  projection,
                  releaseHistory,
                  currentRelease,
                ),
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

  async function seedWebhook(label: string) {
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
      emptyGraph: { schemaVersion: 1, settings: {}, nodes: [], edges: [] },
      idempotencyKey: `direct-webhook-create-${label}`,
    });
    const graph = {
      schemaVersion: 1 as const,
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
    if (trigger === undefined)
      throw new Error('Webhook trigger is unavailable');
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
      actorId,
      endpointKey,
      originalSecret,
      provisioned,
      trigger,
      workflowId: created.workflowId,
    };
  }

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
          schemaVersion: 1,
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
          'outboxEventId,runId,schemaVersion,workspaceId'
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

  async function activateWebhookRelease(): Promise<void> {
    const descriptions = releaseHistory.descriptions;
    const currentResult = await apiPool.query<{
      epoch: number;
      fingerprint: string;
    }>(
      `select epoch,fingerprint
         from app.node_compatibility_current
        where singleton=true`,
    );
    const current = currentResult.rows[0];
    const currentIndex = descriptions.findIndex(
      ({ epoch, fingerprint }) =>
        epoch === current?.epoch && fingerprint === current.fingerprint,
    );
    if (currentIndex === -1)
      throw new Error('Current webhook compatibility release is unsupported');
    const maintenanceOwner = new FixtureResourceOwner();
    try {
      const maintenance = maintenanceOwner.acquire(
        'compatibility maintenance',
        createCompatibilityReleaseMaintenance(
          parseDatabaseConfig({
            connectionString: configuredDatabaseUrl(migrationBaseUrl),
            max: 1,
            ownerRole,
            workerRuntimeRole: workerRole,
          }),
        ),
        (value) => value.close(),
      );
      for (
        let index = currentIndex + 1;
        index < descriptions.length;
        index += 1
      ) {
        const predecessor = descriptions[index - 1];
        const target = descriptions[index];
        if (predecessor === undefined || target === undefined)
          throw new Error('Compatibility history is incomplete');
        const pair = [predecessor, target] as const;
        const probeOwner = new FixtureResourceOwner();
        try {
          const apiProbe = probeOwner.acquire(
            'API compatibility probe',
            createCompatibilityReleaseReadinessProbe(
              parseDatabaseConfig({
                connectionString: configuredDatabaseUrl(apiBaseUrl),
                max: 1,
                ownerRole,
                workerRuntimeRole: workerRole,
              }),
              pair,
            ),
            (value) => value.close(),
          );
          const workerProbe = probeOwner.acquire(
            'worker compatibility probe',
            createCompatibilityReleaseReadinessProbe(
              parseDatabaseConfig({
                connectionString: configuredDatabaseUrl(workerBaseUrl),
                max: 1,
                ownerRole,
                workerRuntimeRole: workerRole,
              }),
              pair,
            ),
            (value) => value.close(),
          );
          const deploymentId = `webhook-integration-${String(target.epoch)}-${randomUUID()}`;
          const approvalId = randomUUID();
          await maintenance.prepare({
            actorId: 'webhook-integration',
            actorKind: 'deployment',
            expectedPredecessor: predecessor,
            reason: `Prepare webhook integration epoch ${String(target.epoch)}`,
            target,
          });
          await apiProbe.checkTarget(target);
          await workerProbe.checkTarget(target);
          await maintenance.recordPreactivation({
            artifactId: `api-${String(target.epoch)}`,
            checkId: randomUUID(),
            deploymentId,
            roleKind: 'api',
            target,
          });
          await maintenance.recordPreactivation({
            artifactId: `worker-${String(target.epoch)}`,
            checkId: randomUUID(),
            deploymentId,
            roleKind: 'worker',
            target,
          });
          await maintenance.approve({
            actorId: 'webhook-integration',
            approvalId,
            deploymentId,
            reason: `Approve webhook integration epoch ${String(target.epoch)}`,
            requiredApiArtifacts: [`api-${String(target.epoch)}`],
            requiredWorkerArtifacts: [`worker-${String(target.epoch)}`],
            target,
          });
          await maintenance.activate({
            activationId: randomUUID(),
            actorId: 'webhook-integration',
            actorKind: 'deployment',
            approvalId,
            expectedPredecessor: predecessor,
            reason: `Activate webhook integration epoch ${String(target.epoch)}`,
          });
        } catch (error: unknown) {
          await rethrowFixtureSetupFailure(probeOwner, error);
        }
        await probeOwner.close();
      }
    } catch (error: unknown) {
      await rethrowFixtureSetupFailure(maintenanceOwner, error);
    }
    await maintenanceOwner.close();
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
