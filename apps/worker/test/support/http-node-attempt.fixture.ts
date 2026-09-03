import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  acceptWorkflowRun,
  createConnectionDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
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
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
export const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/14';
  return parsed.toString();
})();

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
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'pnpm',
      [
        '--filter',
        '@pertexo/database',
        '--fail-if-no-match',
        'exec',
        'tsx',
        'src/migrate.ts',
      ],
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

export function installHttpNodeAttemptFixture(): void {
  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(
        `create database "${databaseName}" owner pertexo_owner`,
      );
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
}
