import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  createDualRegionArtifactStore,
  parseDualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  acceptWorkflowRun,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  createConnectionDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  type ConnectionDatabase,
} from '@pertexo/database';
import {
  ConnectionEnvelopeEncryption,
  SecureHttpClient,
  type ConnectionSecretContext,
  type EnvelopeKeyProvider,
  type SecureHttpTransportRequest,
} from '@pertexo/integrations/server';
import {
  PLATFORM_REGISTRY_RELEASE_HISTORY,
  PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
} from '@pertexo/node-catalog';
import type { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  describeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';
import type { Attributes, Meter, Span, Tracer } from '@opentelemetry/api';
import { Queue } from 'bullmq';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dropDisconnectedDatabase } from './support/disposable-database.js';

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { createProductionHttpProviderTelemetry } from '../src/execution/http-provider-telemetry.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import { createWorkerNodeRuntimeCapabilities } from '../src/execution/node-runtime-capabilities.js';

const enabled =
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true' &&
  process.env.ARTIFACT_STORE_INTEGRATION === 'true';
const describeIntegration = enabled ? describe : describe.skip;
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/14';
  return parsed.toString();
})();

const databaseName = `pertexo_test_http_attempt_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const actorId = randomUUID();
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
const connectionId = randomUUID();
const secretVersionId = randomUUID();
const slackConnectionId = randomUUID();
const slackSecretVersionId = randomUUID();
const emailConnectionId = randomUUID();
const emailSecretVersionId = randomUUID();
const rotatedEmailSecretVersionId = randomUUID();
const plaintextSecret = `Bearer http-attempt-${randomUUID()}`;
const slackBotToken = `xoxb-${randomUUID()}-secret`;
const slackMessageText = `deployment-${randomUUID()}`;
const resendApiKey = `re_${randomUUID().replaceAll('-', '')}`;
const rotatedResendApiKey = `re_${randomUUID().replaceAll('-', '')}`;
const emailRecipient = `recipient-${randomUUID()}@example.test`;
const emailSubject = `subject-${randomUUID()}`;
const emailText = `text-${randomUUID()}`;
const responseBytes = 70_000;
const activeRelease = composeExecutableCompatibilityRelease(
  PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
);

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function redisConnection() {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1)),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

const ownerPool = new Pool({
  connectionString: databaseUrl(migrationUrl),
  max: 1,
});
const workerPool = new Pool({
  connectionString: databaseUrl(workerUrl),
  max: 3,
});
const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 2 }),
);
let connectionDatabase: ConnectionDatabase | undefined;

async function withOwner<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function workerQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await workerPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<T>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function waitFor<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMillis = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMillis;
  let value = await operation();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    value = await operation();
  }
  if (!predicate(value))
    throw new Error(`HTTP attempt proof timed out: ${JSON.stringify(value)}`);
  return value;
}

async function migrateDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['--filter', '@pertexo/database', 'exec', 'tsx', 'src/migrate.ts'],
      {
        cwd: new URL('../../../', import.meta.url).pathname,
        env: {
          ...process.env,
          DATABASE_MIGRATION_URL: databaseUrl(migrationUrl),
        },
        stdio: 'inherit',
      },
    );
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`HTTP attempt migration failed: ${String(code)}`));
    });
  });
}

async function activateRelease(
  targetRelease: typeof PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
): Promise<void> {
  const target = describeExecutableCompatibilityRelease(
    composeExecutableCompatibilityRelease(targetRelease),
  );
  const currentRows = await withOwner((client) =>
    client.query<{ catalog_json: unknown; epoch: number; fingerprint: string }>(
      `select current.epoch,current.fingerprint,release.catalog_json
       from app.node_compatibility_current current
       join app.node_compatibility_releases release
         on release.epoch=current.epoch and release.fingerprint=current.fingerprint`,
    ),
  );
  const current = currentRows.rows[0];
  if (current === undefined) throw new Error('compatibility pointer missing');
  const predecessor = {
    catalogJson:
      typeof current.catalog_json === 'string'
        ? current.catalog_json
        : JSON.stringify(current.catalog_json),
    epoch: current.epoch,
    fingerprint: current.fingerprint,
  };
  const supported = [predecessor, target];
  const maintenance = createCompatibilityReleaseMaintenance(
    parseDatabaseConfig({
      connectionString: databaseUrl(migrationUrl),
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    }),
  );
  const apiProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 1 }),
    supported,
  );
  const workerProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: databaseUrl(workerUrl), max: 1 }),
    supported,
  );
  const epoch = String(target.epoch);
  const deploymentId = `http-attempt-${epoch}-${randomUUID()}`;
  const approvalId = randomUUID();
  try {
    await maintenance.prepare({
      actorId: 'http-attempt-integration',
      actorKind: 'deployment',
      expectedPredecessor: predecessor,
      reason: 'Prepare HTTP attempt integration release',
      target,
    });
    await Promise.all([
      apiProbe.checkTarget(target),
      workerProbe.checkTarget(target),
    ]);
    for (const roleKind of ['api', 'worker'] as const)
      await maintenance.recordPreactivation({
        artifactId: `http-attempt-${roleKind}-${epoch}`,
        checkId: randomUUID(),
        deploymentId,
        roleKind,
        target,
      });
    await maintenance.approve({
      actorId: 'http-attempt-integration',
      approvalId,
      deploymentId,
      reason: 'Approve HTTP attempt integration release',
      requiredApiArtifacts: [`http-attempt-api-${epoch}`],
      requiredWorkerArtifacts: [`http-attempt-worker-${epoch}`],
      target,
    });
    await maintenance.activate({
      activationId: randomUUID(),
      actorId: 'http-attempt-integration',
      actorKind: 'deployment',
      approvalId,
      expectedPredecessor: predecessor,
      reason: 'Activate HTTP attempt integration release',
    });
  } finally {
    await Promise.allSettled([
      maintenance.close(),
      apiProbe.close(),
      workerProbe.close(),
    ]);
  }
}

function graph() {
  return {
    schemaVersion: 1 as const,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'http',
        definition: { key: 'http.request', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {
          method: 'GET',
          url: 'https://provider.example.test/resource',
          headers: { accept: 'application/json' },
          timeoutMillis: 5_000,
          maxRedirects: 0,
          maxResponseBytes: 100_000,
          inlineResponseBytes: 1_024,
        },
        inputMappings: {},
        connectionRefs: { http_headers: connectionId },
      },
      {
        id: 'slack',
        definition: { key: 'slack.send_message', version: 1 },
        position: { x: 20, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          channelId: { kind: 'literal' as const, value: 'C123ABC' },
          text: { kind: 'literal' as const, value: slackMessageText },
        },
        connectionRefs: { slack_bot_token: slackConnectionId },
      },
      {
        id: 'email',
        definition: { key: 'email.send_notification', version: 1 },
        position: { x: 30, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          toEmail: { kind: 'literal' as const, value: emailRecipient },
          subject: { kind: 'literal' as const, value: emailSubject },
          text: { kind: 'literal' as const, value: emailText },
        },
        connectionRefs: { resend_api_key: emailConnectionId },
      },
      {
        id: 'email-rotated',
        definition: { key: 'email.send_notification', version: 1 },
        position: { x: 40, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          toEmail: { kind: 'literal' as const, value: emailRecipient },
          subject: { kind: 'literal' as const, value: emailSubject },
          text: { kind: 'literal' as const, value: emailText },
        },
        connectionRefs: { resend_api_key: emailConnectionId },
      },
    ],
    edges: [
      {
        id: 'manual-http',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'http', port: 'in' },
      },
      {
        id: 'http-slack',
        source: { nodeId: 'http', port: 'out' },
        target: { nodeId: 'slack', port: 'in' },
      },
      {
        id: 'slack-email',
        source: { nodeId: 'slack', port: 'out' },
        target: { nodeId: 'email', port: 'in' },
      },
      {
        id: 'email-rotated',
        source: { nodeId: 'email', port: 'out' },
        target: { nodeId: 'email-rotated', port: 'in' },
      },
    ],
  };
}

class ContextKeyProvider implements EnvelopeKeyProvider {
  private readonly key = randomBytes(32);

  generateDataKey(context: ConnectionSecretContext) {
    return Promise.resolve({
      plaintextKey: new Uint8Array(this.key),
      encryptedDataKey: new TextEncoder().encode(JSON.stringify(context)),
      keyReference: 'integration-context-key',
    });
  }

  decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: ConnectionSecretContext,
  ) {
    if (
      keyReference !== 'integration-context-key' ||
      new TextDecoder().decode(encryptedDataKey) !== JSON.stringify(context)
    )
      throw new Error('encryption context mismatch');
    return Promise.resolve(new Uint8Array(this.key));
  }
}

async function seedFixture(): Promise<ConnectionEnvelopeEncryption> {
  const executable = buildWorkflowExecutableV2({
    graph: graph(),
    release: activeRelease,
  });
  await withOwner(async (client) => {
    await client.query(
      `insert into app.users (id,email,display_name,status)
       values ($1,$2,'HTTP attempt proof','active')`,
      [actorId, `http-attempt-${actorId}@example.test`],
    );
    await client.query(
      `insert into app.workspaces (id,name,slug,status,created_by)
       values ($1,'HTTP attempt proof',$2,'active',$3)`,
      [workspaceId, `http-attempt-${workspaceId}`, actorId],
    );
    await client.query(
      `insert into app.workspace_memberships
         (workspace_id,user_id,role,status)
       values ($1,$2,'owner','active')`,
      [workspaceId, actorId],
    );
    await client.query(
      `insert into app.workflows (id,workspace_id,name,created_by)
       values ($1,$2,'HTTP attempt proof',$3)`,
      [workflowId, workspaceId, actorId],
    );
    await client.query(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,schema_version,graph_json,
         checksum,executable_schema_version,executable_json,
         compatibility_release_epoch,published_by
       ) values ($1,$2,$3,1,1,$4::jsonb,$5,2,$6::jsonb,$7,$8)`,
      [
        workflowVersionId,
        workspaceId,
        workflowId,
        JSON.stringify(graph()),
        executable.checksum,
        JSON.stringify(executable.envelope),
        activeRelease.epoch,
        actorId,
      ],
    );
  });

  const encryption = new ConnectionEnvelopeEncryption(new ContextKeyProvider());
  const secret = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      type: 'http_headers',
      headers: { authorization: plaintextSecret },
    }),
  );
  const sealed = await encryption.seal(secret, {
    workspaceId,
    connectionId,
    secretVersionId,
  });
  const connections = createConnectionDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 2 }),
  );
  connectionDatabase = connections;
  await connections.createConnection({
    workspaceId,
    actorId,
    connectionId,
    secretVersionId,
    providerKey: 'http',
    name: 'HTTP attempt credential',
    authType: 'http_headers',
    sealed,
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
  });
  const slackSecret = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      type: 'slack_bot_token',
      botToken: slackBotToken,
    }),
  );
  const sealedSlackSecret = await encryption.seal(slackSecret, {
    workspaceId,
    connectionId: slackConnectionId,
    secretVersionId: slackSecretVersionId,
  });
  await connections.createConnection({
    workspaceId,
    actorId,
    connectionId: slackConnectionId,
    secretVersionId: slackSecretVersionId,
    providerKey: 'slack',
    name: 'Slack attempt credential',
    authType: 'slack_bot_token',
    sealed: sealedSlackSecret,
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
  });
  const emailSecret = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      type: 'resend_api_key',
      apiKey: resendApiKey,
      fromEmail: 'sender@example.test',
    }),
  );
  const sealedEmailSecret = await encryption.seal(emailSecret, {
    workspaceId,
    connectionId: emailConnectionId,
    secretVersionId: emailSecretVersionId,
  });
  await connections.createConnection({
    workspaceId,
    actorId,
    connectionId: emailConnectionId,
    secretVersionId: emailSecretVersionId,
    providerKey: 'email',
    name: 'Email attempt credential',
    authType: 'resend_api_key',
    sealed: sealedEmailSecret,
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
  });
  return encryption;
}

async function acceptRun() {
  return apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      engineVersion: 'http-attempt-engine-v1',
      initialCheckpoint: createCheckpoint({
        engineVersion: 'http-attempt-engine-v1',
        workflowVersionId,
        iterationBudget: 0,
        nextEventSequence: 2,
      }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      runInput: {},
      scope: `http-attempt:${workflowId}`,
      triggerType: 'manual',
      workflowId,
      workflowVersionId,
    }),
  );
}

async function attemptDelivery(
  runId: string,
  nodeId: string,
  expectedAttempts = 1,
) {
  const rows = await waitFor(
    () =>
      workerQuery<{
        attempt_id: string;
        node_run_id: string;
        outbox_id: string;
      }>(
        `select attempt.id attempt_id,node.id node_run_id,outbox.id outbox_id
         from app.node_runs node
         join app.node_attempts attempt
           on attempt.workspace_id=node.workspace_id and attempt.node_run_id=node.id
         join app.outbox_events outbox
           on outbox.workspace_id=attempt.workspace_id
          and outbox.aggregate_id=attempt.id
          and outbox.job_name='execute-node-attempt'
          where node.workspace_id=$1 and node.workflow_run_id=$2 and node.node_id=$3
          order by attempt.attempt_number desc`,
        [workspaceId, runId, nodeId],
      ),
    (value) => value.length === expectedAttempts,
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`${nodeId} attempt delivery missing`);
  return row;
}

async function continuation(runId: string, excluded: readonly string[]) {
  const rows = await waitFor(
    () =>
      workerQuery<{ id: string }>(
        `select id from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='advance-workflow-run' and not (id=any($3::uuid[]))
         order by created_at,id`,
        [workspaceId, runId, excluded],
      ),
    (value) => value.length > 0,
  );
  if (rows[0] === undefined)
    throw new Error('coordinator continuation missing');
  return rows[0].id;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase();
  for (const release of PLATFORM_REGISTRY_RELEASE_HISTORY.slice(1).filter(
    (candidate) => candidate.epoch <= activeRelease.epoch,
  ))
    await activateRelease(release);
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([
    connectionDatabase?.close(),
    apiDatabase.close(),
    ownerPool.end(),
    workerPool.end(),
  ]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describeIntegration('active HTTP node attempt', () => {
  it('commits artifact, attempt truth, audit, bounded telemetry, and inert exact redelivery without leaking credentials', async () => {
    const encryption = await seedFixture();
    const accepted = await acceptRun();
    const artifactConfig = parseDualRegionArtifactStoreConfig(process.env);
    const artifactVerifier = createDualRegionArtifactStore(
      artifactConfig.primary,
      artifactConfig.recovery,
    );
    const transportRequests: SecureHttpTransportRequest[] = [];
    const slackRequests: {
      botToken: string;
      channelId: string;
      text: string;
    }[] = [];
    const emailRequests: {
      apiKey: string;
      fromEmail: string;
      toEmail: string;
      subject: string;
      text: string;
      idempotencyKey: string;
    }[] = [];
    const telemetry: {
      kind: 'count' | 'duration' | 'span';
      name: string;
      attributes?: Attributes;
    }[] = [];
    const meter = {
      createCounter: (name: string) => ({
        add: (_value: number, attributes?: Attributes) =>
          telemetry.push({
            kind: 'count',
            name,
            ...(attributes === undefined ? {} : { attributes }),
          }),
      }),
      createHistogram: (name: string) => ({
        record: (_value: number, attributes?: Attributes) =>
          telemetry.push({
            kind: 'duration',
            name,
            ...(attributes === undefined ? {} : { attributes }),
          }),
      }),
    } as unknown as Meter;
    const tracer = {
      startActiveSpan: async <T>(
        name: string,
        work: (span: Span) => Promise<T>,
      ): Promise<T> => {
        const attributes: Attributes = {};
        const span = {
          setAttribute: (key: string, value: unknown) => {
            attributes[key] = value as never;
            return span;
          },
          setStatus: () => span,
          end: () => telemetry.push({ kind: 'span', name, attributes }),
        } as unknown as Span;
        return work(span);
      },
    } as unknown as Tracer;
    const httpClient = new SecureHttpClient(
      {
        resolve: () =>
          Promise.resolve([{ address: '8.8.8.8', family: 4 as const }]),
      },
      {
        dispatch: (request) => {
          transportRequests.push(request);
          return Promise.resolve({
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
            body: (async function* () {
              await Promise.resolve();
              yield new Uint8Array(35_000).fill(7);
              yield new Uint8Array(35_000).fill(9);
            })(),
            close: () => undefined,
          });
        },
      },
    );
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
      {
        httpRequest: { httpClient },
        httpRequestTelemetry: createProductionHttpProviderTelemetry({
          meter,
          tracer,
        }),
        slackSendMessage: {
          client: {
            sendMessage: async (input) => {
              await input.beforeDispatch();
              slackRequests.push({
                botToken: input.botToken,
                channelId: input.channelId,
                text: input.text,
              });
              return {
                kind: 'succeeded',
                channelId: input.channelId,
                messageTs: '1724412345.000100',
              };
            },
          },
        },
        emailSendNotification: {
          client: {
            sendNotification: async (input) => {
              await input.beforeDispatch();
              emailRequests.push({
                apiKey: input.apiKey,
                fromEmail: input.fromEmail,
                toEmail: input.toEmail,
                subject: input.subject,
                text: input.text,
                idempotencyKey: input.idempotencyKey,
              });
              if (emailRequests.length === 1)
                return {
                  kind: 'rate_limited' as const,
                  retryAfterMillis: 1_000,
                };
              if (emailRequests.length === 3)
                return { kind: 'invalid_response' as const };
              return {
                kind: 'succeeded',
                emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
              };
            },
          },
        },
      },
    );
    const capabilities = await createWorkerNodeRuntimeCapabilities(
      {
        artifactStore: artifactConfig,
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 3,
        }),
      },
      { connectionEncryption: encryption },
    );
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    await Promise.all([
      attemptQueue.obliterate({ force: true }),
      coordinatorQueue.obliterate({ force: true }),
    ]);
    const coordinator = await createCoordinatorRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 3,
      }),
      maximumAdmissions: 1,
      redisUrl,
      releaseCohort: 'email_activation',
    });
    const attempts = await createNodeAttemptRuntime(
      {
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 4,
        }),
        heartbeatIntervalMillis: 200,
        leaseDurationSeconds: 10,
        redisUrl,
        releaseCohort: 'email_activation',
        workerId: `http-attempt-${randomUUID().slice(0, 8)}`,
      },
      { registry, runtimeCapabilities: capabilities.factories },
    );
    const producer = createQueueProducer({ redisUrl });
    const coordinatorOutboxes = [accepted.outboxEventId];
    let persistedArtifactId: string | undefined;
    try {
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const initialCoordinatorJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: accepted.outboxEventId,
        },
      });
      const persistedInitialJob = await waitFor(
        () => coordinatorQueue.getJob(initialCoordinatorJob.jobId),
        (job) => job !== undefined,
      );
      if (persistedInitialJob === undefined)
        throw new Error('Initial coordinator job missing');
      await waitFor(
        () => persistedInitialJob.getState(),
        (state) => state === 'completed' || state === 'failed',
      );
      if ((await persistedInitialJob.getState()) === 'failed')
        throw new Error(
          `Initial coordinator job failed: ${persistedInitialJob.failedReason}`,
        );

      const manual = await attemptDelivery(accepted.runId, 'manual');
      await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: manual.node_run_id,
          attemptId: manual.attempt_id,
          outboxEventId: manual.outbox_id,
        },
      });
      const firstContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(firstContinuation);
      const httpAdmission = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: firstContinuation,
        },
      });
      const admissionJob = await waitFor(
        () => coordinatorQueue.getJob(httpAdmission.jobId),
        (job) => job !== undefined,
      );
      if (admissionJob === undefined)
        throw new Error('HTTP admission job missing');
      await waitFor(
        () => admissionJob.getState(),
        (state) => state === 'completed' || state === 'failed',
      );
      if ((await admissionJob.getState()) === 'failed')
        throw new Error(
          `HTTP admission failed: ${JSON.stringify(await coordinatorQueue.getJob(httpAdmission.jobId))}`,
        );

      const http = await attemptDelivery(accepted.runId, 'http');
      const delivery = {
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1 as const,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: http.node_run_id,
          attemptId: http.attempt_id,
          outboxEventId: http.outbox_id,
        },
      };
      const published = await producer.publish(delivery);
      const terminal = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            node_status: string;
            output_ref: unknown;
            attempt_provider_key: string | null;
            attempt_side_effect_class: string;
            node_provider_key: string | null;
            node_side_effect_class: string;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    node.status node_status,attempt.output_ref,
                    attempt.side_effect_class attempt_side_effect_class,
                    attempt.provider_idempotency_key attempt_provider_key,
                    node.side_effect_class node_side_effect_class,
                    node.provider_idempotency_key node_provider_key
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, http.attempt_id],
          ),
        (rows) => rows[0]?.attempt_status === 'succeeded',
      );
      expect(terminal[0]).toMatchObject({
        attempt_status: 'succeeded',
        attempt_provider_key: null,
        attempt_side_effect_class: 'unsafe',
        node_status: 'succeeded',
        node_provider_key: null,
        node_side_effect_class: 'unsafe',
      });
      expect(terminal[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(terminal[0]?.output_ref).toMatchObject({
        kind: 'inline',
        value: {
          status: 200,
          body: { kind: 'artifact', byteLength: responseBytes },
        },
      });
      const artifactId = (
        terminal[0]?.output_ref as {
          value: { body: { artifactId: string } };
        }
      ).value.body.artifactId;
      persistedArtifactId = artifactId;
      const expectedArtifact = Buffer.concat([
        Buffer.alloc(35_000, 7),
        Buffer.alloc(35_000, 9),
      ]);
      const artifactStream = await artifactVerifier.getStream({
        artifactId,
        workspaceId,
      });
      const artifactChunks: Buffer[] = [];
      for await (const chunk of artifactStream.body) {
        if (!(chunk instanceof Uint8Array))
          throw new TypeError('HTTP artifact chunk is not bytes');
        artifactChunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(artifactChunks)).toEqual(expectedArtifact);
      expect(transportRequests).toHaveLength(1);
      expect(transportRequests[0]?.headers.authorization).toBe(plaintextSecret);

      const durable = await workerQuery<{
        artifact_count: string;
        event_types: string[];
        inbox_completed: string;
        inbox_count: string;
        usage_count: string;
      }>(
        `select
          (select count(*)::text from app.artifacts artifact
            where artifact.workspace_id=$1 and artifact.id=$3
              and artifact.status='available' and artifact.byte_length=$4
              and artifact.sha256=$6) artifact_count,
          (select count(*)::text from app.inbox_receipts receipt
            where receipt.workspace_id=$1 and receipt.message_id=$5
              and receipt.consumer_name='node-attempt-worker') inbox_count,
          (select count(receipt.completed_at)::text from app.inbox_receipts receipt
            where receipt.workspace_id=$1 and receipt.message_id=$5
              and receipt.consumer_name='node-attempt-worker') inbox_completed,
          (select count(*)::text from app.usage_events usage
            where usage.workspace_id=$1 and usage.resource_id=$2) usage_count,
          (select array_agg(type order by sequence) from app.run_events event
            where event.workspace_id=$1 and event.workflow_run_id=$2) event_types`,
        [
          workspaceId,
          accepted.runId,
          artifactId,
          responseBytes,
          http.outbox_id,
          createHash('sha256').update(expectedArtifact).digest('hex'),
        ],
      );
      const audit = await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
           where workspace_id=$1 and connection_id=$2
             and event_type='connection.credential_accessed'
             and actor_kind='worker'`,
          [workspaceId, connectionId],
        ),
      );
      expect(audit.rows[0]?.count).toBe('1');
      expect(durable[0]).toEqual({
        artifact_count: '1',
        event_types: [
          'run.queued',
          'run.started',
          'node.ready',
          'node.started',
          'node.succeeded',
          'node.ready',
          'node.started',
          'node.succeeded',
        ],
        inbox_completed: '1',
        inbox_count: '1',
        usage_count: '0',
      });

      expect(telemetry).toHaveLength(3);
      expect(telemetry.map(({ kind, name }) => ({ kind, name }))).toEqual([
        { kind: 'count', name: 'pertexo.provider.request.count' },
        { kind: 'duration', name: 'pertexo.provider.request.duration' },
        { kind: 'span', name: 'pertexo.provider.http.request' },
      ]);
      for (const record of telemetry)
        expect(record.attributes).toEqual({
          provider_key: 'http',
          operation_key: 'request',
          outcome: 'succeeded',
          possibly_dispatched: true,
          response_storage: 'artifact',
          status_class: '2xx',
        });

      const completedJob = await waitFor(
        () => attemptQueue.getJob(published.jobId),
        (job) => job !== undefined,
      );
      if (completedJob === undefined) throw new Error('HTTP job missing');
      await waitFor(
        () => completedJob.getState(),
        (state) => state === 'completed',
      );
      const beforeRedelivery = await workerQuery<{ fact: string }>(
        `select concat_ws('|',attempt.status,attempt.fence_token,
                           attempt.dispatch_marked_at,attempt.output_ref::text,
                           attempt.side_effect_class,attempt.provider_idempotency_key,
                           node.status,node.output_ref::text,
                           node.side_effect_class,node.provider_idempotency_key,
                           (select count(*) from app.run_events event
                            where event.workspace_id=attempt.workspace_id
                              and event.workflow_run_id=$2),
                           (select count(*) from app.inbox_receipts receipt
                             where receipt.workspace_id=attempt.workspace_id
                               and receipt.message_id=$3),
                           (select count(*) from app.usage_events usage
                             where usage.workspace_id=attempt.workspace_id
                               and usage.resource_id=$2),
                           (select count(*) from app.artifacts artifact
                             where artifact.workspace_id=attempt.workspace_id
                               and artifact.id=$5)) fact
         from app.node_attempts attempt
         join app.node_runs node
           on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
         where attempt.workspace_id=$1 and attempt.id=$4`,
        [
          workspaceId,
          accepted.runId,
          http.outbox_id,
          http.attempt_id,
          artifactId,
        ],
      );
      await completedJob.remove();
      await producer.publish(delivery);
      const replay = await waitFor(
        () => attemptQueue.getJob(published.jobId),
        (job) => job !== undefined,
      );
      if (replay === undefined) throw new Error('redelivered HTTP job missing');
      await waitFor(
        () => replay.getState(),
        (state) => state === 'completed',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await expect(
        workerQuery<{ fact: string }>(
          `select concat_ws('|',attempt.status,attempt.fence_token,
                             attempt.dispatch_marked_at,attempt.output_ref::text,
                             attempt.side_effect_class,attempt.provider_idempotency_key,
                             node.status,node.output_ref::text,
                             node.side_effect_class,node.provider_idempotency_key,
                            (select count(*) from app.run_events event
                              where event.workspace_id=attempt.workspace_id
                                and event.workflow_run_id=$2),
                             (select count(*) from app.inbox_receipts receipt
                               where receipt.workspace_id=attempt.workspace_id
                                 and receipt.message_id=$3),
                             (select count(*) from app.usage_events usage
                               where usage.workspace_id=attempt.workspace_id
                                 and usage.resource_id=$2),
                             (select count(*) from app.artifacts artifact
                               where artifact.workspace_id=attempt.workspace_id
                                 and artifact.id=$5)) fact
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and attempt.id=$4`,
          [
            workspaceId,
            accepted.runId,
            http.outbox_id,
            http.attempt_id,
            artifactId,
          ],
        ),
      ).resolves.toEqual(beforeRedelivery);
      expect(transportRequests).toHaveLength(1);
      expect(telemetry).toHaveLength(3);
      const auditAfterRedelivery = await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
           where workspace_id=$1 and connection_id=$2
             and event_type='connection.credential_accessed'
             and actor_kind='worker'`,
          [workspaceId, connectionId],
        ),
      );
      expect(auditAfterRedelivery.rows).toEqual(audit.rows);

      const slackContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(slackContinuation);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: slackContinuation,
        },
      });
      const slack = await attemptDelivery(accepted.runId, 'slack');
      const slackDelivery = {
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1 as const,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: slack.node_run_id,
          attemptId: slack.attempt_id,
          outboxEventId: slack.outbox_id,
        },
      };
      const slackJob = await producer.publish(slackDelivery);
      const slackTerminal = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            executor_error_kind: string | null;
            executor_failure_kind: string | null;
            error_summary: string | null;
            node_status: string;
            output_ref: unknown;
            safe_error_code: string | null;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    attempt.executor_error_kind,attempt.executor_failure_kind,
                    attempt.error_summary,
                    attempt.safe_error_code,node.status node_status,attempt.output_ref
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, slack.attempt_id],
          ),
        (rows) => rows[0]?.attempt_status === 'succeeded',
      );
      expect(slackTerminal[0]).toMatchObject({
        attempt_status: 'succeeded',
        node_status: 'succeeded',
        output_ref: {
          kind: 'inline',
          value: {
            channelId: 'C123ABC',
            messageTs: '1724412345.000100',
          },
        },
      });
      expect(slackTerminal[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(slackRequests).toEqual([
        {
          botToken: slackBotToken,
          channelId: 'C123ABC',
          text: slackMessageText,
        },
      ]);
      const slackAudit = await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
           where workspace_id=$1 and connection_id=$2
             and event_type='connection.credential_accessed'
             and actor_kind='worker'`,
          [workspaceId, slackConnectionId],
        ),
      );
      expect(slackAudit.rows[0]?.count).toBe('1');
      const completedSlackJob = await waitFor(
        () => attemptQueue.getJob(slackJob.jobId),
        (job) => job !== undefined,
      );
      if (completedSlackJob === undefined) throw new Error('Slack job missing');
      await waitFor(
        () => completedSlackJob.getState(),
        (state) => state === 'completed',
      );
      await completedSlackJob.remove();
      await producer.publish(slackDelivery);
      const replayedSlackJob = await waitFor(
        () => attemptQueue.getJob(slackJob.jobId),
        (job) => job !== undefined,
      );
      if (replayedSlackJob === undefined)
        throw new Error('redelivered Slack job missing');
      await waitFor(
        () => replayedSlackJob.getState(),
        (state) => state === 'completed',
      );
      expect(slackRequests).toHaveLength(1);

      const emailContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(emailContinuation);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: emailContinuation,
        },
      });
      const email = await attemptDelivery(accepted.runId, 'email');
      const emailDelivery = {
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1 as const,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: email.node_run_id,
          attemptId: email.attempt_id,
          outboxEventId: email.outbox_id,
        },
      };
      const emailJob = await producer.publish(emailDelivery);
      const firstEmailAttempt = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            executor_failure_kind: string | null;
            executor_possibly_dispatched: boolean | null;
            node_status: string;
            output_ref: unknown;
            provider_dispatch_binding: string | null;
            provider_idempotency_key: string | null;
            retry_decision: string | null;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                     attempt.provider_idempotency_key,node.status node_status,
                     node.provider_dispatch_binding,
                     attempt.output_ref,attempt.executor_failure_kind,
                     attempt.executor_possibly_dispatched,
                     attempt.retry_decision
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, email.attempt_id],
          ),
        (rows) => rows[0]?.attempt_status === 'failed',
      );
      expect(firstEmailAttempt[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(firstEmailAttempt[0]?.executor_failure_kind).toBe('retry');
      expect(firstEmailAttempt[0]?.executor_possibly_dispatched).toBe(false);
      expect(firstEmailAttempt[0]?.retry_decision).toBe('pending');
      const retryContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(retryContinuation);
      const retryCoordinatorJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: retryContinuation,
        },
      });
      const persistedRetryCoordinatorJob = await waitFor(
        () => coordinatorQueue.getJob(retryCoordinatorJob.jobId),
        (job) => job !== undefined,
      );
      if (persistedRetryCoordinatorJob === undefined)
        throw new Error('Email retry coordinator job missing');
      await waitFor(
        () => persistedRetryCoordinatorJob.getState(),
        (state) => state === 'completed',
      );
      await waitFor(
        () =>
          workerQuery<{ retry_decision: string | null }>(
            `select retry_decision from app.node_attempts
             where workspace_id=$1 and id=$2`,
            [workspaceId, email.attempt_id],
          ),
        (rows) => rows[0]?.retry_decision === 'retry',
      );
      const dueContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(dueContinuation);
      const dueCoordinatorJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: dueContinuation,
        },
      });
      const persistedDueCoordinatorJob = await waitFor(
        () => coordinatorQueue.getJob(dueCoordinatorJob.jobId),
        (job) => job !== undefined,
      );
      if (persistedDueCoordinatorJob === undefined)
        throw new Error('Email due coordinator job missing');
      await waitFor(
        () => persistedDueCoordinatorJob.getState(),
        (state) => state === 'completed',
      );
      const retriedEmail = await attemptDelivery(accepted.runId, 'email', 2);
      const retriedEmailDelivery = {
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1 as const,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: retriedEmail.node_run_id,
          attemptId: retriedEmail.attempt_id,
          outboxEventId: retriedEmail.outbox_id,
        },
      };
      const retriedEmailJob = await producer.publish(retriedEmailDelivery);
      const emailTerminal = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            node_status: string;
            output_ref: unknown;
            provider_dispatch_binding: string | null;
            provider_idempotency_key: string | null;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    attempt.provider_idempotency_key,node.status node_status,
                    node.provider_dispatch_binding,
                    attempt.output_ref
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, retriedEmail.attempt_id],
          ),
        (rows) => rows[0]?.attempt_status === 'succeeded',
      );
      expect(emailTerminal[0]).toMatchObject({
        attempt_status: 'succeeded',
        node_status: 'succeeded',
        output_ref: {
          kind: 'inline',
          value: { emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' },
        },
      });
      expect(emailTerminal[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(emailTerminal[0]?.provider_idempotency_key).toMatch(
        /^v1\.[0-9a-f]{64}$/u,
      );
      expect(emailTerminal[0]?.provider_dispatch_binding).toBe(
        `email:v1:sha256:${createHash('sha256')
          .update(`email\0${emailConnectionId}\0${emailSecretVersionId}`)
          .digest('hex')}`,
      );
      expect(emailTerminal[0]?.provider_dispatch_binding).not.toContain(
        'sender@example.test',
      );
      expect(emailRequests).toHaveLength(2);
      expect(emailRequests[0]).toEqual({
        apiKey: resendApiKey,
        fromEmail: 'sender@example.test',
        toEmail: emailRecipient,
        subject: emailSubject,
        text: emailText,
        idempotencyKey: emailTerminal[0]?.provider_idempotency_key,
      });
      expect(emailRequests[1]).toEqual(emailRequests[0]);
      const completedEmailJob = await waitFor(
        () => attemptQueue.getJob(emailJob.jobId),
        (job) => job !== undefined,
      );
      if (completedEmailJob === undefined) throw new Error('Email job missing');
      await waitFor(
        () => completedEmailJob.getState(),
        (state) => state === 'completed',
      );
      await waitFor(
        () => attemptQueue.getJob(retriedEmailJob.jobId),
        (job) => job !== undefined,
      );
      await completedEmailJob.remove();
      await producer.publish(emailDelivery);
      const replayedEmailJob = await waitFor(
        () => attemptQueue.getJob(emailJob.jobId),
        (job) => job !== undefined,
      );
      if (replayedEmailJob === undefined)
        throw new Error('redelivered email job missing');
      await waitFor(
        () => replayedEmailJob.getState(),
        (state) => state === 'completed',
      );
      expect(emailRequests).toHaveLength(2);

      const rotatedAdmission = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(rotatedAdmission);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: rotatedAdmission,
        },
      });
      const rotatedFirst = await attemptDelivery(
        accepted.runId,
        'email-rotated',
      );
      await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: rotatedFirst.node_run_id,
          attemptId: rotatedFirst.attempt_id,
          outboxEventId: rotatedFirst.outbox_id,
        },
      });
      await waitFor(
        () =>
          workerQuery<{ status: string }>(
            `select status from app.node_attempts
             where workspace_id=$1 and id=$2`,
            [workspaceId, rotatedFirst.attempt_id],
          ),
        (rows) => rows[0]?.status === 'failed',
      );
      expect(emailRequests).toHaveLength(3);

      const rotatedRetry = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(rotatedRetry);
      const rotatedRetryJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: rotatedRetry,
        },
      });
      const persistedRotatedRetryJob = await waitFor(
        () => coordinatorQueue.getJob(rotatedRetryJob.jobId),
        (job) => job !== undefined,
      );
      if (persistedRotatedRetryJob === undefined)
        throw new Error('Rotated email retry coordinator job missing');
      await waitFor(
        () => persistedRotatedRetryJob.getState(),
        (state) => state === 'completed',
      );

      const rotatedSecret = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          type: 'resend_api_key',
          apiKey: rotatedResendApiKey,
          fromEmail: 'sender@example.test',
        }),
      );
      const sealedRotatedSecret = await encryption.seal(rotatedSecret, {
        workspaceId,
        connectionId: emailConnectionId,
        secretVersionId: rotatedEmailSecretVersionId,
      });
      rotatedSecret.fill(0);
      if (connectionDatabase === undefined)
        throw new Error('Connection database missing');
      await connectionDatabase.rotateConnectionSecret({
        workspaceId,
        actorId,
        connectionId: emailConnectionId,
        secretVersionId: rotatedEmailSecretVersionId,
        expectedCurrentSecretVersionId: emailSecretVersionId,
        expectedAuthType: 'resend_api_key',
        sealed: sealedRotatedSecret,
        idempotencyKey: randomUUID(),
        requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      });

      const rotatedDue = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(rotatedDue);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: rotatedDue,
        },
      });
      const rotatedSecond = await attemptDelivery(
        accepted.runId,
        'email-rotated',
        2,
      );
      await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: rotatedSecond.node_run_id,
          attemptId: rotatedSecond.attempt_id,
          outboxEventId: rotatedSecond.outbox_id,
        },
      });
      const rotatedTerminal = await waitFor(
        () =>
          workerQuery<{
            attempt_status: string;
            dispatch_marked_at: Date | null;
            executor_failure_kind: string | null;
            executor_possibly_dispatched: boolean | null;
            node_status: string;
          }>(
            `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    attempt.executor_failure_kind,
                    attempt.executor_possibly_dispatched,
                    node.status node_status
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, rotatedSecond.attempt_id],
          ),
        (rows) => rows[0]?.executor_failure_kind === 'outcome_unknown',
      );
      expect(rotatedTerminal[0]).toMatchObject({
        attempt_status: 'failed',
        dispatch_marked_at: null,
        executor_failure_kind: 'outcome_unknown',
        executor_possibly_dispatched: true,
        node_status: 'running',
      });
      expect(emailRequests).toHaveLength(3);
      const rotatedTerminalContinuation = await continuation(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(rotatedTerminalContinuation);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: rotatedTerminalContinuation,
        },
      });
      await waitFor(
        () =>
          workerQuery<{ status: string }>(
            `select status from app.node_runs
             where workspace_id=$1 and id=$2`,
            [workspaceId, rotatedSecond.node_run_id],
          ),
        (rows) => rows[0]?.status === 'outcome_unknown',
      );
      expect(emailRequests).toHaveLength(3);

      const durableSurface = await withOwner((client) =>
        client.query<{ surface: string }>(
          `select concat_ws(E'\n',
             (select jsonb_agg(to_jsonb(secret))::text
                from app.connection_secret_versions secret where workspace_id=$1),
             (select jsonb_agg(to_jsonb(event))::text
                from app.connection_events event where workspace_id=$1),
             (select jsonb_agg(to_jsonb(attempt))::text
                from app.node_attempts attempt where workspace_id=$1),
             (select jsonb_agg(to_jsonb(node))::text
                from app.node_runs node where workspace_id=$1),
             (select jsonb_agg(to_jsonb(event))::text
                from app.run_events event where workspace_id=$1),
             (select jsonb_agg(to_jsonb(event))::text
                from app.outbox_events event where workspace_id=$1),
             (select jsonb_agg(to_jsonb(receipt))::text
                from app.inbox_receipts receipt where workspace_id=$1),
             (select jsonb_agg(to_jsonb(artifact))::text
                from app.artifacts artifact where workspace_id=$1)) surface`,
          [workspaceId],
        ),
      );
      const queueSurface = JSON.stringify([delivery, replay.toJSON()]);
      expect(durableSurface.rows[0]?.surface).not.toContain(plaintextSecret);
      expect(durableSurface.rows[0]?.surface).not.toContain(slackBotToken);
      expect(durableSurface.rows[0]?.surface).not.toContain(slackMessageText);
      expect(durableSurface.rows[0]?.surface).not.toContain(resendApiKey);
      expect(durableSurface.rows[0]?.surface).not.toContain(
        rotatedResendApiKey,
      );
      expect(durableSurface.rows[0]?.surface).not.toContain(emailRecipient);
      expect(durableSurface.rows[0]?.surface).not.toContain(emailSubject);
      expect(durableSurface.rows[0]?.surface).not.toContain(emailText);
      expect(queueSurface).not.toContain(plaintextSecret);
      expect(
        JSON.stringify([slackDelivery, replayedSlackJob.toJSON()]),
      ).not.toContain(slackBotToken);
      expect(
        JSON.stringify([emailDelivery, replayedEmailJob.toJSON()]),
      ).not.toContain(resendApiKey);
      expect(JSON.stringify(telemetry)).not.toContain(plaintextSecret);
    } finally {
      await Promise.allSettled([
        attempts.close(),
        coordinator.close(),
        producer.close(),
        attemptQueue.close(),
        coordinatorQueue.close(),
        capabilities.close(),
        ...(persistedArtifactId === undefined
          ? []
          : [
              artifactVerifier
                .delete({ artifactId: persistedArtifactId, workspaceId })
                .catch(() => undefined),
            ]),
      ]);
      artifactVerifier.close();
    }
  }, 30_000);
});
