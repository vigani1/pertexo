import { createHash, createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';

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
} from '@pertexo/database';
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
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import { createCoreWorkflowAuthoringDatabase } from '../../src/platform/workflow/workflow-runtime.module.js';
import { createInitialWorkflowCheckpoint } from '../../src/workflow-runs/postgres-persistence.js';
import { WebhookManagementService } from '../../src/webhooks/service.js';
import { dropDisconnectedDatabase } from '../support/disposable-database.js';

const adminBaseUrl = process.env.DATABASE_ADMIN_URL;
const migrationBaseUrl = process.env.DATABASE_MIGRATION_URL;
const apiBaseUrl = process.env.DATABASE_API_URL;
const workerBaseUrl = process.env.DATABASE_WORKER_URL;
const enabled =
  process.env.API_WEBHOOK_INTEGRATION === 'true' &&
  adminBaseUrl !== undefined &&
  migrationBaseUrl !== undefined &&
  apiBaseUrl !== undefined &&
  workerBaseUrl !== undefined;
const databaseName = `pertexo_test_api_webhook_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = (base: string): string => {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
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
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  const owner = new Pool({
    connectionString: databaseUrl(migrationBaseUrl ?? ''),
    max: 1,
  });
  const apiPool = new Pool({
    connectionString: databaseUrl(apiBaseUrl ?? ''),
    max: 1,
  });
  const apiConfig = parseDatabaseConfig({
    connectionString: databaseUrl(apiBaseUrl ?? ''),
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 2_000,
    max: 12,
    ownerRole,
    workerRuntimeRole: workerRole,
  });
  const releaseSupport = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport('webhook_activation').map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const releaseHistory = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory('webhook_activation').map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const identity = createIdentityWorkspaceDatabase(apiConfig);
  const authoring = createCoreWorkflowAuthoringDatabase(
    apiConfig,
    'webhook_activation',
  );
  const reconciliation = createWorkflowTriggerReconciliationDatabase(apiConfig);
  const webhookDatabase = createWebhookTriggerDatabase(
    apiConfig,
    releaseSupport.descriptions,
  );
  const workspaceDatabase = createWorkspaceDatabase(apiConfig, {
    compatibilityReleases: releaseSupport.descriptions,
  });
  const encryption = new WebhookTriggerEnvelopeEncryption(
    new DeterministicEnvelopeKeys(),
  );
  const service = new WebhookManagementService(webhookDatabase, encryption);
  let failVerification = false;
  const ingressDatabase: WebhookTriggerDatabase = {
    provision: (input) => webhookDatabase.provision(input),
    rotateEndpoint: (input) => webhookDatabase.rotateEndpoint(input),
    rotateSecret: (input) => webhookDatabase.rotateSecret(input),
    getHealth: (input) => webhookDatabase.getHealth(input),
    resolveVerification: async (endpointKeyHash) => {
      if (failVerification) throw new Error('forced webhook database outage');
      return webhookDatabase.resolveVerification(endpointKeyHash);
    },
    consumeIngressLimit: (endpointKeyHash) =>
      webhookDatabase.consumeIngressLimit(endpointKeyHash),
    acceptVerifiedDelivery: (input) =>
      webhookDatabase.acceptVerifiedDelivery(input),
    close: () => Promise.resolve(),
  };
  let application: Awaited<ReturnType<typeof createApiApplication>> | undefined;
  let origin = '';
  let workspaceId = '';

  beforeAll(async () => {
    await admin.query(`create database "${databaseName}" owner ${ownerRole}`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to ${migrationRole},${apiRole},${workerRole},${dispatcherRole}`,
    );
    await migrateDatabase({
      connectionString: databaseUrl(migrationBaseUrl ?? ''),
      ownerRole,
      apiRuntimeRole: apiRole,
      workerRuntimeRole: workerRole,
      dispatcherRole,
    });
    await activateWebhookRelease();
  }, 120_000);

  afterAll(async () => {
    await application?.close();
    await Promise.allSettled([
      webhookDatabase.close(),
      workspaceDatabase.close(),
      reconciliation.close(),
      authoring.close(),
      identity.close(),
      owner.end(),
      apiPool.end(),
    ]);
    try {
      await dropDisconnectedDatabase(admin, databaseName);
    } finally {
      await admin.end();
    }
  }, 30_000);

  it('proves authenticated acceptance, replay, conflicts, rollback, rotation, quota, failure bounds, and leakage safety', async () => {
    const actorId = randomUUID();
    workspaceId = randomUUID();
    await identity.createUser({
      id: actorId,
      email: `webhook-http-${actorId}@example.test`,
      displayName: 'Webhook HTTP integration',
    });
    await identity.createWorkspaceWithOwner({
      id: workspaceId,
      name: 'Webhook HTTP integration',
      slug: `webhook-http-${actorId}`,
      ownerUserId: actorId,
      idempotencyKey: `webhook-http-${actorId}`,
    });

    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Direct webhook gate',
      emptyGraph: { schemaVersion: 1, settings: {}, nodes: [], edges: [] },
      idempotencyKey: 'direct-webhook-create',
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
      idempotencyKey: 'direct-webhook-publish',
      requestHash: sha256('direct-webhook-publish'),
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
      actorId,
      triggerId: trigger.id,
      idempotencyKey: 'direct-webhook-provision',
    });
    expect(provisioned.trigger).toMatchObject({
      status: 'active',
      endpointReady: true,
    });
    expect(provisioned.endpointKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(provisioned.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const endpointKey = requireString(provisioned.endpointKey);
    const originalSecret = requireString(provisioned.signingSecret);
    await expect(
      service.provision({
        workspaceId,
        actorId,
        triggerId: trigger.id,
        idempotencyKey: 'direct-webhook-provision',
      }),
    ).resolves.toEqual({ trigger: provisioned.trigger, replayed: true });

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
    application = await createApiApplication(config, {
      database: workspaceDatabase,
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
    });
    await application.listen(0, '127.0.0.1');
    const address = application.getHttpServer().address();
    if (address === null || typeof address === 'string')
      throw new Error('Webhook HTTP listener address is unavailable');
    origin = `http://127.0.0.1:${String(address.port)}`;

    const rawBody = Buffer.from(
      '{  "raw-byte-marker" : "payload-value", "nested" : {"ok":true} }\n',
      'utf8',
    );
    const key = 'sender-delivery-key';
    const first = await sendWebhook(endpointKey, originalSecret, rawBody, key);
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

    const beforeMalformed = await durableCounts();
    const malformed = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"valid-signature":"invalid-json"'),
      'malformed-json',
    );
    expectProblem(malformed, 400, 'webhook.invalid_json');
    expect(await durableCounts()).toEqual(beforeMalformed);

    const rotated = await service.rotateSecret({
      workspaceId,
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
      currentSecret,
      Buffer.from('{"quota":"rejected"}'),
      'quota-rejected',
    );
    expectProblem(quota, 429, 'webhook.rate_limited');
    expect(quota.headers['retry-after']).toBe('5');
    expect(await durableCounts()).toEqual(beforeQuota);

    const durableText =
      (
        await apiQuery<{ surface: string }>(
          `select string_agg(surface,E'\n') surface from (
          select to_jsonb(delivery)::text surface from app.webhook_trigger_deliveries delivery where workspace_id=$1
          union all select to_jsonb(replay)::text from app.webhook_trigger_replay_records replay where workspace_id=$1
          union all select to_jsonb(run)::text from app.workflow_runs run where workspace_id=$1
          union all select to_jsonb(event)::text from app.run_events event where workspace_id=$1
          union all select to_jsonb(checkpoint)::text from app.run_checkpoints checkpoint where workspace_id=$1
          union all select to_jsonb(outbox)::text from app.outbox_events outbox where workspace_id=$1
        ) durable`,
          [workspaceId],
        )
      ).rows[0]?.surface ?? '';
    const signature = signatureFor(
      originalSecret,
      String(Math.floor(Date.now() / 1000)),
      rawBody,
    );
    expect(durableText).not.toContain(rawBody.toString('utf8'));
    expect(durableText).not.toContain(signature);
    expect(durableText).not.toContain(endpointKey);
    expect(durableText).not.toContain(originalSecret);
    expect(durableText).not.toContain(currentSecret);
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

    failVerification = true;
    const failureStarted = performance.now();
    const unavailable = await sendWebhook(
      endpointKey,
      currentSecret,
      Buffer.from('{"database":"unavailable"}'),
      'database-unavailable',
    );
    const failureMillis = performance.now() - failureStarted;
    expectProblem(unavailable, 503, 'webhook.unavailable');
    expect(failureMillis).toBeLessThan(2_000);

    const endpointRotation = {
      workspaceId,
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
    const maintenance = createCompatibilityReleaseMaintenance(
      parseDatabaseConfig({
        connectionString: databaseUrl(migrationBaseUrl ?? ''),
        max: 1,
        ownerRole,
        workerRuntimeRole: workerRole,
      }),
    );
    try {
      for (let index = 1; index < descriptions.length; index += 1) {
        const predecessor = descriptions[index - 1];
        const target = descriptions[index];
        if (predecessor === undefined || target === undefined)
          throw new Error('Compatibility history is incomplete');
        const pair = [predecessor, target] as const;
        const apiProbe = createCompatibilityReleaseReadinessProbe(
          parseDatabaseConfig({
            connectionString: databaseUrl(apiBaseUrl ?? ''),
            max: 1,
            ownerRole,
            workerRuntimeRole: workerRole,
          }),
          pair,
        );
        const workerProbe = createCompatibilityReleaseReadinessProbe(
          parseDatabaseConfig({
            connectionString: databaseUrl(workerBaseUrl ?? ''),
            max: 1,
            ownerRole,
            workerRuntimeRole: workerRole,
          }),
          pair,
        );
        const deploymentId = `webhook-integration-${String(target.epoch)}-${randomUUID()}`;
        const approvalId = randomUUID();
        try {
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
        } finally {
          await Promise.all([apiProbe.close(), workerProbe.close()]);
        }
      }
    } finally {
      await maintenance.close();
    }
  }

  async function ownerQuery<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: unknown[] = [],
  ) {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${ownerRole}`);
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

  async function sendWebhook(
    endpointKey: string,
    secret: string,
    rawBody: Buffer,
    idempotencyKey: string,
  ): Promise<HttpResponse> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const url = new URL(`/hooks/${endpointKey}`, origin);
    return new Promise((resolve, reject) => {
      const request = http.request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(rawBody.byteLength),
            'idempotency-key': idempotencyKey,
            'x-pertexo-timestamp': timestamp,
            'x-pertexo-signature': signatureFor(secret, timestamp, rawBody),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              json:
                text === ''
                  ? {}
                  : (JSON.parse(text) as Record<string, unknown>),
            });
          });
        },
      );
      request.once('error', reject);
      request.end(rawBody);
    });
  }
});

type HttpResponse = Readonly<{
  status: number;
  headers: http.IncomingHttpHeaders;
  json: Record<string, unknown>;
}>;

function signatureFor(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  return `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(timestamp, 'ascii')
    .update('.')
    .update(rawBody)
    .digest('hex')}`;
}

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
