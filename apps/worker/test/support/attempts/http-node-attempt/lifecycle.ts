import { createHash, randomUUID } from 'node:crypto';

import {
  createConnectionStore,
  type ConnectionStore,
} from '@pertexo/core/testing';
import {
  createWorkspaceDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';

import { ConnectionEnvelopeEncryption } from '@pertexo/integrations/server';

import { buildWorkflowExecutable } from '@pertexo/workflow-engine';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { dropDisconnectedDatabase } from '../../infrastructure/disposable-database.js';

import { queryAsWorkspaceRole } from '../../workspace-query.js';
import {
  httpNodeAttemptIntegrationEnabled,
  adminUrl,
  migrationUrl,
  apiUrl,
  workerUrl,
  redisNamespace,
  databaseName,
  workspaceId,
  actorId,
  workflowId,
  workflowVersionId,
  connectionId,
  secretVersionId,
  slackConnectionId,
  slackSecretVersionId,
  emailConnectionId,
  emailSecretVersionId,
  plaintextSecret,
  slackBotToken,
  resendApiKey,
  activeCatalog,
  databaseUrl,
} from './environment.js';
import { graph } from './graphs.js';
import { ContextKeyProvider, sealAndZero } from './encryption.js';
import { migrateDatabase } from './migrate.js';

let ownerPool!: Pool;

let workerPool!: Pool;

export let apiDatabase!: ReturnType<typeof createWorkspaceDatabase>;

let ownerPoolCreated = false;

let workerPoolCreated = false;

let apiDatabaseCreated = false;

let databaseCreated = false;

let redisNamespaceAcquired = false;

export let connectionDatabase: ConnectionStore | undefined;

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
  return queryAsWorkspaceRole<T>({
    pool: workerPool,
    workspaceId: workspaceId,
    statement: statement,
    parameters: parameters,
  });
}

export async function seedFixture(): Promise<ConnectionEnvelopeEncryption> {
  const executable = buildWorkflowExecutable({
    graph: graph(),
    catalog: activeCatalog,
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
         id,workspace_id,workflow_id,version_number,graph_json,
         checksum,executable_json,
         published_by
       ) values ($1,$2,$3,1,$4::jsonb,$5,$6::jsonb,$7)`,
      [
        workflowVersionId,
        workspaceId,
        workflowId,
        JSON.stringify(graph()),
        executable.checksum,
        JSON.stringify(executable.envelope),
        actorId,
      ],
    );
  });

  const encryption = new ConnectionEnvelopeEncryption(new ContextKeyProvider());
  const secret = new TextEncoder().encode(
    JSON.stringify({
      type: 'http_headers',
      headers: { authorization: plaintextSecret },
    }),
  );
  const sealed = await sealAndZero(encryption, secret, {
    workspaceId,
    connectionId,
    secretVersionId,
  });
  const connections = createConnectionStore(
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
          `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_app, pertexo_maintenance, pertexo_maintenance`,
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
      apiDatabase = createWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 2 }),
      );
      apiDatabaseCreated = true;
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
