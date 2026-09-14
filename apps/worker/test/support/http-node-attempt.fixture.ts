import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  acceptWorkflowRun,
  createConnectionDatabase,
  createWorkspaceDatabase,
  migrateDatabase as migrateSchema,
  parseDatabaseConfig,
  parseMigrationConfig,
  requestWorkflowRunCancellation,
  type ConnectionDatabase,
} from '@pertexo/database/testing';
import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
  type EnvelopeKeyProvider,
} from '@pertexo/integrations/server';
import {
  PLATFORM_REGISTRY_RELEASE_HISTORY,
  PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
} from '@pertexo/node-catalog';
import type { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
} from '@pertexo/workflow-engine';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { activateCompatibilityReleaseFixture } from './compatibility-release.fixture.js';
import { dropDisconnectedDatabase } from './disposable-database.js';
import { createRedisTestNamespace } from './redis-test-namespace.js';
import { queryAsWorkspaceRole } from './workspace-query.js';

export const httpNodeAttemptIntegrationEnabled =
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true' &&
  process.env.ARTIFACT_STORE_INTEGRATION === 'true';
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
export const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
export const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
export const operatorUrl =
  process.env.DATABASE_OPERATOR_URL ??
  'postgresql://pertexo_operator:pertexo-local-operator@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const redisNamespace = createRedisTestNamespace(
  configuredRedisUrl,
  14,
  'http-node-attempt',
);
export const redisUrl = redisNamespace.redisUrl;

const databaseName = `pertexo_test_http_attempt_${randomUUID().replaceAll('-', '')}`;
export const workspaceId = randomUUID();
export const actorId = randomUUID();
export const workflowId = randomUUID();
export const workflowVersionId = randomUUID();
export const connectionId = randomUUID();
export const secretVersionId = randomUUID();
export const slackConnectionId = randomUUID();
export const slackSecretVersionId = randomUUID();
export const emailConnectionId = randomUUID();
export const emailSecretVersionId = randomUUID();
export const rotatedEmailSecretVersionId = randomUUID();
export const plaintextSecret = `Bearer http-attempt-${randomUUID()}`;
export const slackBotToken = `xoxb-${randomUUID()}-secret`;
export const slackMessageText = `deployment-${randomUUID()}`;
export const resendApiKey = `re_${randomUUID().replaceAll('-', '')}`;
export const rotatedResendApiKey = `re_${randomUUID().replaceAll('-', '')}`;
export const emailRecipient = `recipient-${randomUUID()}@example.test`;
export const emailSubject = `subject-${randomUUID()}`;
export const emailText = `text-${randomUUID()}`;
export const responseBytes = 70_000;
const activeRelease = composeExecutableCompatibilityRelease(
  PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
);

export function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function redisConnection() {
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

let ownerPool!: Pool;
let workerPool!: Pool;
let operatorPool!: Pool;
let apiDatabase!: ReturnType<typeof createWorkspaceDatabase>;
let ownerPoolCreated = false;
let workerPoolCreated = false;
let operatorPoolCreated = false;
let apiDatabaseCreated = false;
let databaseCreated = false;
let redisNamespaceAcquired = false;
export let connectionDatabase: ConnectionDatabase | undefined;

export async function withOwner<T>(work: (client: PoolClient) => Promise<T>) {
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

export async function workerQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  return queryAsWorkspaceRole<T>(
    workerPool,
    workspaceId,
    statement,
    parameters,
  );
}

export async function waitFor<T>(
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
  await migrateSchema(
    parseMigrationConfig({
      ...process.env,
      DATABASE_MIGRATION_URL: databaseUrl(migrationUrl),
      NODE_ENV: 'test',
    }),
  );
}

async function activateRelease(
  targetRelease: typeof PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
): Promise<void> {
  await activateCompatibilityReleaseFixture({
    actorId: 'http-attempt-integration',
    apiUrl: databaseUrl(apiUrl),
    artifactPrefix: 'http-attempt',
    migrationUrl: databaseUrl(migrationUrl),
    reasons: {
      activate: 'Activate HTTP attempt integration release',
      approve: 'Approve HTTP attempt integration release',
      prepare: 'Prepare HTTP attempt integration release',
    },
    readCurrent: async () =>
      (
        await withOwner((client) =>
          client.query<{
            catalog_json: unknown;
            epoch: number;
            fingerprint: string;
          }>(
            `select current.epoch,current.fingerprint,release.catalog_json
             from app.node_compatibility_current current
             join app.node_compatibility_releases release
               on release.epoch=current.epoch and release.fingerprint=current.fingerprint`,
          ),
        )
      ).rows[0],
    targetRelease,
    workerUrl: databaseUrl(workerUrl),
  });
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

type ProviderScenario = 'email' | 'http' | 'slack';

function providerScenarioNode(provider: ProviderScenario) {
  switch (provider) {
    case 'http':
      return {
        id: 'provider',
        definition: { key: 'http.request', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {
          method: 'GET',
          url: 'https://provider.example.test/scenario',
          headers: { accept: 'application/json' },
          timeoutMillis: 5_000,
          maxRedirects: 0,
          maxResponseBytes: 100_000,
          inlineResponseBytes: 100_000,
        },
        inputMappings: {},
        connectionRefs: { http_headers: connectionId },
      };
    case 'slack':
      return {
        id: 'provider',
        definition: { key: 'slack.send_message', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          channelId: { kind: 'literal' as const, value: 'C123ABC' },
          text: { kind: 'literal' as const, value: slackMessageText },
        },
        connectionRefs: { slack_bot_token: slackConnectionId },
      };
    case 'email':
      return {
        id: 'provider',
        definition: { key: 'email.send_notification', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          toEmail: { kind: 'literal' as const, value: emailRecipient },
          subject: { kind: 'literal' as const, value: emailSubject },
          text: { kind: 'literal' as const, value: emailText },
        },
        connectionRefs: { resend_api_key: emailConnectionId },
      };
  }
}

function providerScenarioGraph(provider: ProviderScenario) {
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
      providerScenarioNode(provider),
    ],
    edges: [
      {
        id: 'manual-provider',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'provider', port: 'in' },
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

async function sealAndZero(
  encryption: ConnectionEnvelopeEncryption,
  plaintext: Uint8Array,
  context: ConnectionSecretContext,
) {
  try {
    return await encryption.seal(plaintext, context);
  } finally {
    plaintext.fill(0);
  }
}

export async function seedFixture(): Promise<ConnectionEnvelopeEncryption> {
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
  const sealed = await sealAndZero(encryption, secret, {
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
  const sealedSlackSecret = await sealAndZero(encryption, slackSecret, {
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
  const sealedEmailSecret = await sealAndZero(encryption, emailSecret, {
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

/**
 * Restore the shared schema fixture's provider rows to the immutable seeded
 * versions before each independently named scenario. Runtime state, requests,
 * queues, and run identities remain scenario-local; audit assertions use
 * per-scenario baselines because the immutable connection history is retained.
 */
export async function resetProviderScenarioIsolation(): Promise<void> {
  await withOwner(async (client) => {
    await client.query(
      `update app.connections
          set current_secret_version_id=case id
                when $2::uuid then $3::uuid
                when $4::uuid then $5::uuid
                when $6::uuid then $7::uuid
              end,
              updated_at=clock_timestamp()
        where workspace_id=$1 and id=any($8::uuid[])`,
      [
        workspaceId,
        connectionId,
        secretVersionId,
        slackConnectionId,
        slackSecretVersionId,
        emailConnectionId,
        emailSecretVersionId,
        [connectionId, slackConnectionId, emailConnectionId],
      ],
    );
  });
}

export async function acceptRun() {
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

export async function acceptProviderScenarioRun(provider: ProviderScenario) {
  const scenarioWorkflowId = randomUUID();
  const scenarioWorkflowVersionId = randomUUID();
  const scenarioGraph = providerScenarioGraph(provider);
  const executable = buildWorkflowExecutableV2({
    graph: scenarioGraph,
    release: activeRelease,
  });
  await withOwner(async (client) => {
    await client.query(
      `insert into app.workflows (id,workspace_id,name,created_by)
       values ($1,$2,$3,$4)`,
      [
        scenarioWorkflowId,
        workspaceId,
        `Provider ${provider} scenario`,
        actorId,
      ],
    );
    await client.query(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,schema_version,graph_json,
         checksum,executable_schema_version,executable_json,
         compatibility_release_epoch,published_by
       ) values ($1,$2,$3,1,1,$4::jsonb,$5,2,$6::jsonb,$7,$8)`,
      [
        scenarioWorkflowVersionId,
        workspaceId,
        scenarioWorkflowId,
        JSON.stringify(scenarioGraph),
        executable.checksum,
        JSON.stringify(executable.envelope),
        activeRelease.epoch,
        actorId,
      ],
    );
  });
  const accepted = await apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      engineVersion: 'http-attempt-engine-v1',
      initialCheckpoint: createCheckpoint({
        engineVersion: 'http-attempt-engine-v1',
        workflowVersionId: scenarioWorkflowVersionId,
        iterationBudget: 0,
        nextEventSequence: 2,
      }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      runInput: {},
      scope: `http-attempt-scenario:${scenarioWorkflowId}`,
      triggerType: 'manual',
      workflowId: scenarioWorkflowId,
      workflowVersionId: scenarioWorkflowVersionId,
    }),
  );
  return Object.freeze({
    ...accepted,
    workflowId: scenarioWorkflowId,
    workflowVersionId: scenarioWorkflowVersionId,
  });
}

export async function cancelProviderScenarioRun(runId: string): Promise<void> {
  await apiDatabase.withWorkspace(workspaceId, (transaction) =>
    requestWorkflowRunCancellation(transaction, {
      actor: 'http-attempt-integration',
      reason: 'Exercise durable cancellation in the composed worker proof',
      runId,
    }),
  );
}

export async function expireProviderScenarioRun(runId: string): Promise<void> {
  await withOwner((client) =>
    client.query(
      `update app.workflow_runs
          set deadline_at=clock_timestamp(),updated_at=clock_timestamp()
        where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    ),
  );
}

export async function reclaimProviderScenarioAttempt(input: {
  attemptId: string;
  expectedFence: number;
}) {
  const result = await operatorPool.query<{
    command_outcome: string;
    result: {
      fenceToken: number;
      outboxEventId: string;
      outcome: string;
      schemaVersion: number;
    };
  }>(
    `select command_outcome,result
       from app.reconcile_operator_attempt(
         $1,$2,$3,$4,'reclaim','http-attempt-operator',
         'Recover an expired keyed provider attempt in the composed proof',false
       )`,
    [randomUUID(), workspaceId, input.attemptId, input.expectedFence],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Attempt reclaim result missing');
  return row;
}

export async function attemptDelivery(
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

export async function continuation(runId: string, excluded: readonly string[]) {
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

let fixtureCleanupPromise: Promise<void> | undefined;

function cleanupHttpNodeAttemptFixture(): Promise<void> {
  fixtureCleanupPromise ??= (async () => {
    const errors: unknown[] = [];
    const attempt = async (
      label: string,
      operation: () => unknown,
    ): Promise<void> => {
      await Promise.resolve()
        .then(operation)
        .catch((cause: unknown) => {
          errors.push(
            new Error(`HTTP attempt fixture cleanup failed: ${label}`, {
              cause,
            }),
          );
        });
    };
    const activeConnectionDatabase = connectionDatabase;
    connectionDatabase = undefined;
    if (activeConnectionDatabase !== undefined)
      await attempt('connection database', () =>
        activeConnectionDatabase.close(),
      );
    if (apiDatabaseCreated) {
      await attempt('API database', () => apiDatabase.close());
      apiDatabaseCreated = false;
    }
    if (operatorPoolCreated) {
      await attempt('operator pool', () => operatorPool.end());
      operatorPoolCreated = false;
    }
    if (workerPoolCreated) {
      await attempt('worker pool', () => workerPool.end());
      workerPoolCreated = false;
    }
    if (ownerPoolCreated) {
      await attempt('owner pool', () => ownerPool.end());
      ownerPoolCreated = false;
    }
    if (redisNamespaceAcquired) {
      await attempt('Redis namespace', () => redisNamespace.close());
      redisNamespaceAcquired = false;
    }
    if (databaseCreated) {
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      await attempt('drop disposable database', async () => {
        await dropDisconnectedDatabase(admin, databaseName);
        databaseCreated = false;
      });
      await attempt('admin pool', () => admin.end());
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'HTTP attempt fixture cleanup failed');
  })();
  return fixtureCleanupPromise;
}

export function installHttpNodeAttemptFixture(): void {
  beforeAll(async () => {
    try {
      if (!httpNodeAttemptIntegrationEnabled) return;
      await redisNamespace.acquire();
      redisNamespaceAcquired = true;
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      let setupError: unknown;
      try {
        await admin.query(
          `create database "${databaseName}" owner pertexo_owner`,
        );
        databaseCreated = true;
        await admin.query(
          `revoke all on database "${databaseName}" from public`,
        );
        await admin.query(
          `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher, pertexo_operator`,
        );
      } catch (error: unknown) {
        setupError = error;
      }
      await admin.end().catch((error: unknown) => {
        setupError =
          setupError === undefined
            ? error
            : new AggregateError(
                [setupError, error],
                'HTTP attempt database setup failed',
              );
      });
      if (setupError !== undefined)
        throw setupError instanceof Error
          ? setupError
          : new Error('HTTP attempt database setup failed', {
              cause: setupError,
            });
      await migrateDatabase();

      ownerPool = new Pool({
        connectionString: databaseUrl(migrationUrl),
        max: 1,
      });
      ownerPoolCreated = true;
      workerPool = new Pool({
        connectionString: databaseUrl(workerUrl),
        max: 3,
      });
      workerPoolCreated = true;
      operatorPool = new Pool({
        connectionString: databaseUrl(operatorUrl),
        max: 1,
      });
      operatorPoolCreated = true;
      apiDatabase = createWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 2 }),
      );
      apiDatabaseCreated = true;
      for (const release of PLATFORM_REGISTRY_RELEASE_HISTORY.slice(1).filter(
        (candidate) => candidate.epoch <= activeRelease.epoch,
      ))
        await activateRelease(release);
    } catch (setupError: unknown) {
      let cleanupError: unknown;
      await cleanupHttpNodeAttemptFixture().catch((error: unknown) => {
        cleanupError = error;
      });
      if (cleanupError === undefined) throw setupError;
      throw new AggregateError(
        [setupError, cleanupError],
        'HTTP attempt fixture setup failed',
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (!httpNodeAttemptIntegrationEnabled) return;
    await cleanupHttpNodeAttemptFixture();
  });
}
