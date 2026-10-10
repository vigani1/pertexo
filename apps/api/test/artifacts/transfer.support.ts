import { randomUUID } from 'node:crypto';

import {
  createArtifactStore,
  type ArtifactDownloadCapability,
  type ArtifactStore,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store';

import {
  createIdentityWorkspaceDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  type IdentityWorkspaceDatabase,
  type WorkspaceDatabase,
} from '@pertexo/database/testing';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { Pool, type PoolClient } from 'pg';
import { expect } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import {
  createApiArtifactRuntime,
  type ApiArtifactRuntime,
} from '../../src/platform/artifacts/artifact-runtime.module.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import {
  issueBrowserSession,
  type HttpSessionCookies,
} from '../webhooks/browser-session.fixture.js';
import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../browser/harness/resource-owner.js';

const apiUrl = process.env.DATABASE_URL;
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@127.0.0.1:5432/pertexo';
const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@127.0.0.1:6379/0';
const emailDomain = 'artifact-transfer.integration.test';

const requiredArtifactEnvironment = {
  ARTIFACT_STORE_ACCESS_KEY_ID: process.env.ARTIFACT_STORE_ACCESS_KEY_ID,
  ARTIFACT_STORE_BUCKET: process.env.ARTIFACT_STORE_BUCKET,
  ARTIFACT_STORE_ENDPOINT: process.env.ARTIFACT_STORE_ENDPOINT,
  ARTIFACT_STORE_SECRET_ACCESS_KEY:
    process.env.ARTIFACT_STORE_SECRET_ACCESS_KEY,
  ARTIFACT_STORE_REGION: process.env.ARTIFACT_STORE_REGION,
};

export const artifactTransferIntegrationRequested =
  process.env.API_ARTIFACT_INTEGRATION === 'true';
export const artifactTransferIntegrationEnabled =
  artifactTransferIntegrationRequested &&
  apiUrl !== undefined &&
  Object.values(requiredArtifactEnvironment).every(
    (value) => value !== undefined && value.trim() !== '',
  );

export type SessionCookies = HttpSessionCookies;

export type ArtifactRequestMetadata = Readonly<{
  byteLength: number;
  mediaType: string;
  sha256: string;
}>;

export type ArtifactRecordSnapshot = Readonly<{
  id: string;
  workspaceId: string;
  purpose: string;
  storageKey: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  status: string;
  expiresAt: Date;
  finalizedAt: Date | null;
  deletedAt: Date | null;
}>;

export type ArtifactCapacitySnapshot = Readonly<{
  byteLimit: number;
  artifactCountLimit: number;
  chargedBytes: number;
  chargedCount: number;
}>;

type VerificationStore = ArtifactStore & ArtifactDownloadCapability;

export type ArtifactStorageCallSnapshot = Readonly<{
  beginDirectDownload: number;
  beginDirectUpload: number;
  validateDirectUpload: number;
}>;

export type ArtifactTransferApiFixture = Readonly<{
  application: Awaited<ReturnType<typeof createApiApplication>>;
  workspaceDatabase: WorkspaceDatabase;
  identityDatabase: IdentityWorkspaceDatabase;
  workspaceId: string;
  otherWorkspaceId: string;
  ownerUserId: string;
  operatorUserId: string;
  viewerUserId: string;
  verificationStore: VerificationStore;
  afterNextUploadVerification(callback: () => Promise<void>): void;
  readDurableTransferEvidence(artifactId: string): Promise<readonly string[]>;
  readLogText(): string;
  readStorageCalls(): ArtifactStorageCallSnapshot;
  login(subject: 'owner' | 'operator' | 'viewer'): Promise<SessionCookies>;
  withOwner<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  withApi<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  setCapacity(
    input: Readonly<{
      byteLimit: number;
      artifactCountLimit: number;
    }>,
  ): Promise<void>;
  setWorkspaceStatus(
    status: 'active' | 'suspended' | 'pending_deletion',
  ): Promise<void>;
  readCapacity(): Promise<ArtifactCapacitySnapshot>;
  readArtifact(artifactId: string): Promise<ArtifactRecordSnapshot | null>;
  expireArtifact(artifactId: string): Promise<void>;
  close(): Promise<void>;
}>;

type FixtureLogCapture = Readonly<{
  logger: StructuredLogger;
  readText(): string;
}>;

function createFixtureLogCapture(): FixtureLogCapture {
  const lines: string[] = [];
  const capture = (
    event: string,
    fields: Readonly<Record<string, unknown>> | undefined,
    error: unknown,
  ): void => {
    let fieldsText = '';
    if (fields !== undefined) {
      try {
        fieldsText = JSON.stringify(fields);
      } catch {
        fieldsText = '[unserializable fields]';
      }
    }
    const errorText =
      error === undefined
        ? ''
        : error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : '[unserializable error]';
    lines.push(`${event} ${fieldsText} ${errorText}`.trim());
  };
  return Object.freeze({
    logger: Object.freeze({
      debug: capture,
      error: capture,
      fatal: capture,
      info: capture,
      trace: capture,
      warn: capture,
    }),
    readText: () => lines.join('\n'),
  });
}

const telemetry: TelemetryLifecycle = {
  enabled: false,
  started: false,
  start: () => undefined,
  shutdown: () => Promise.resolve(),
};

export const artifactTransferDatabaseConfig = parseDatabaseConfig({
  connectionString:
    apiUrl ?? 'postgresql://invalid:invalid@127.0.0.1:5432/invalid',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 8,
  ownerRole,
});

export async function createArtifactTransferApiFixture(): Promise<ArtifactTransferApiFixture> {
  if (!artifactTransferIntegrationEnabled) {
    throw new Error(
      'Artifact transfer integration requires API_ARTIFACT_INTEGRATION and all database/object-store settings',
    );
  }
  const resources = new FixtureResourceOwner();
  const logs = createFixtureLogCapture();
  try {
    const identityDatabase = resources.acquire(
      'identity database',
      createIdentityWorkspaceDatabase(artifactTransferDatabaseConfig),
      (database) => database.close(),
    );
    const workspaceDatabase = resources.acquire(
      'workspace database',
      createWorkspaceDatabase(artifactTransferDatabaseConfig),
      (database) => database.close(),
    );
    const subjects = {
      owner: await resolveIdentity(identityDatabase, 'owner'),
      operator: await resolveIdentity(identityDatabase, 'operator'),
      viewer: await resolveIdentity(identityDatabase, 'viewer'),
    } as const;
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const ownerPool = resources.acquire(
      'owner pool',
      new Pool({
        connectionString: databaseUrl(migrationUrl, databaseNameFromUrl()),
        max: 1,
      }),
      (pool) => pool.end(),
    );
    const apiPool = resources.acquire(
      'API pool',
      new Pool({
        connectionString: artifactTransferDatabaseConfig.connectionString,
        max: 1,
      }),
      (pool) => pool.end(),
    );
    const apiRole =
      apiUrl === undefined
        ? 'pertexo_app'
        : decodeURIComponent(new URL(apiUrl).username);
    const configuredArtifactStore = artifactStoreConfig();
    const verificationStore = resources.acquire(
      'verification store',
      createArtifactStore(configuredArtifactStore),
      (store) => {
        store.close();
      },
    );
    const storageCalls = {
      beginDirectDownload: 0,
      beginDirectUpload: 0,
      validateDirectUpload: 0,
    };
    let afterNextUploadVerification: (() => Promise<void>) | undefined;
    const apiStore = Object.freeze({
      beginDirectDownload: (
        ...args: Parameters<VerificationStore['beginDirectDownload']>
      ) => {
        storageCalls.beginDirectDownload += 1;
        return verificationStore.beginDirectDownload(...args);
      },
      beginDirectUpload: (
        ...args: Parameters<VerificationStore['beginDirectUpload']>
      ) => {
        storageCalls.beginDirectUpload += 1;
        return verificationStore.beginDirectUpload(...args);
      },
      checkReadiness: (
        ...args: Parameters<VerificationStore['checkReadiness']>
      ) => verificationStore.checkReadiness(...args),
      close: () => {
        verificationStore.close();
      },
      validateDirectUpload: async (
        ...args: Parameters<VerificationStore['validateDirectUpload']>
      ) => {
        storageCalls.validateDirectUpload += 1;
        const result = await verificationStore.validateDirectUpload(...args);
        const callback = afterNextUploadVerification;
        afterNextUploadVerification = undefined;
        if (callback !== undefined) await callback();
        return result;
      },
    });
    const withOwner = <T>(work: (client: PoolClient) => Promise<T>) =>
      withRoleClient(ownerPool, ownerRole, workspaceId, work);
    const withApi = <T>(work: (client: PoolClient) => Promise<T>) =>
      withRoleClient(apiPool, apiRole, workspaceId, work);

    await withOwner(async (client) => {
      await client.query(
        `insert into app.workspaces
           (id,name,slug,status,created_by)
         values ($1,$2,$3,'active',$4),($5,$6,$7,'active',$4)`,
        [
          workspaceId,
          'Artifact transfer proof',
          `artifact-transfer-${randomUUID().slice(0, 12)}`,
          subjects.owner.user.id,
          otherWorkspaceId,
          'Unrelated artifact workspace',
          `artifact-other-${randomUUID().slice(0, 12)}`,
        ],
      );
      await client.query(
        `insert into app.workspace_memberships
           (workspace_id,user_id,role,status)
         values
           ($1,$2,'owner','active'),
           ($1,$3,'operator','active'),
           ($1,$4,'viewer','active')`,
        [
          workspaceId,
          subjects.owner.user.id,
          subjects.operator.user.id,
          subjects.viewer.user.id,
        ],
      );
      await client.query(
        `insert into app.workspace_artifact_capacity
           (workspace_id,byte_limit,artifact_count_limit,charged_bytes,charged_count)
         values ($1,1073741824,1000,0,0)
         on conflict (workspace_id) do nothing`,
        [workspaceId],
      );
    });

    const config = artifactApiConfig();
    if (config.identity === undefined || config.artifacts === undefined)
      throw new Error('Artifact integration config is incomplete');
    const identityRuntime = resources.acquire(
      'identity runtime',
      await createApiIdentityRuntime(config.identity, config.database, {
        persistence: { database: identityDatabase },
      }),
      (runtime) => runtime.close(),
    );
    resources.transfer(identityDatabase);
    const createdArtifactRuntime = createApiArtifactRuntime(
      config.artifacts,
      config.database,
      identityRuntime,
      { store: apiStore },
    );
    // S3Mock reports its own bucket region. The store remains real; this
    // fixture bypasses only the startup region probe.
    const runtime: ApiArtifactRuntime = Object.freeze({
      ...createdArtifactRuntime,
      checkReadiness: () => Promise.resolve(),
    });
    resources.acquire('artifact runtime', runtime, (selected) =>
      selected.close(),
    );
    resources.transfer(verificationStore);
    const application = resources.acquire(
      'API application',
      await createApiApplication(config, {
        database: workspaceDatabase,
        identityRuntime,
        artifactRuntime: runtime,
        rateLimitConsumer: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
        logger: logs.logger,
        telemetry,
      }),
      (selected) => selected.close(),
    );
    resources.transfer(workspaceDatabase);
    resources.transfer(identityRuntime);
    resources.transfer(runtime);
    return Object.freeze({
      application,
      workspaceDatabase,
      identityDatabase,
      workspaceId,
      otherWorkspaceId,
      ownerUserId: subjects.owner.user.id,
      operatorUserId: subjects.operator.user.id,
      viewerUserId: subjects.viewer.user.id,
      verificationStore,
      afterNextUploadVerification: (callback) => {
        afterNextUploadVerification = callback;
      },
      readDurableTransferEvidence: (artifactId) =>
        withApi(async (client) => {
          const idempotency = await client.query<{ value: string }>(
            `select result_ref::text as value
               from app.idempotency_records
              where workspace_id=$1 and operation='artifact.upload'
                and resource_id=$2`,
            [workspaceId, artifactId],
          );
          const audit = await client.query<{ value: string }>(
            `select metadata::text as value
               from app.audit_events
              where workspace_id=$1`,
            [workspaceId],
          );
          const outbox = await client.query<{ value: string }>(
            `select payload::text as value
               from app.outbox_events
              where workspace_id=$1`,
            [workspaceId],
          );
          return Object.freeze([
            ...idempotency.rows.map((row) => `idempotency:${row.value}`),
            ...audit.rows.map((row) => `audit:${row.value}`),
            ...outbox.rows.map((row) => `outbox:${row.value}`),
          ]);
        }),
      readLogText: logs.readText,
      readStorageCalls: () => Object.freeze({ ...storageCalls }),
      login: (subject: 'owner' | 'operator' | 'viewer') =>
        issueBrowserSession(
          identityRuntime.dependencies.sessions,
          subjects[subject].user.id,
        ),
      withOwner,
      withApi,
      setCapacity: (input) =>
        withOwner(async (client) => {
          await client.query(
            `update app.workspace_artifact_capacity
                set byte_limit=$2,artifact_count_limit=$3,updated_at=clock_timestamp()
              where workspace_id=$1`,
            [workspaceId, input.byteLimit, input.artifactCountLimit],
          );
        }),
      setWorkspaceStatus: (status) =>
        withOwner(async (client) => {
          if (status === 'pending_deletion') {
            await client.query(
              `update app.workspaces
                  set status='pending_deletion',deletion_requested_at=clock_timestamp(),
                      deletion_requested_by=$2,deletion_reason='artifact integration test',
                      purge_after=clock_timestamp()+interval '1 day'
                where id=$1`,
              [workspaceId, subjects.owner.user.id],
            );
            return;
          }
          await client.query(
            `update app.workspaces
                set status=$2,deletion_requested_at=null,deletion_requested_by=null,
                    deletion_reason=null,purge_after=null
              where id=$1`,
            [workspaceId, status],
          );
        }),
      readCapacity: () =>
        withOwner(async (client) => {
          const result = await client.query<{
            byte_limit: number | string;
            artifact_count_limit: number;
            charged_bytes: number | string;
            charged_count: number;
          }>(
            `select byte_limit,artifact_count_limit,charged_bytes,charged_count
               from app.workspace_artifact_capacity where workspace_id=$1`,
            [workspaceId],
          );
          const row = result.rows[0];
          if (row === undefined) throw new Error('artifact capacity missing');
          return {
            byteLimit: Number(row.byte_limit),
            artifactCountLimit: row.artifact_count_limit,
            chargedBytes: Number(row.charged_bytes),
            chargedCount: row.charged_count,
          };
        }),
      readArtifact: (artifactId) =>
        withOwner(async (client) => {
          const result = await client.query<{
            id: string;
            workspace_id: string;
            purpose: string;
            storage_key: string;
            media_type: string;
            byte_length: number | string;
            sha256: string;
            status: string;
            expires_at: Date;
            finalized_at: Date | null;
            deleted_at: Date | null;
          }>(
            `select id,workspace_id,purpose,storage_key,media_type,byte_length,
                    sha256,status,expires_at,finalized_at,deleted_at
               from app.artifacts where workspace_id=$1 and id=$2`,
            [workspaceId, artifactId],
          );
          const row = result.rows[0];
          return row === undefined
            ? null
            : {
                id: row.id,
                workspaceId: row.workspace_id,
                purpose: row.purpose,
                storageKey: row.storage_key,
                mediaType: row.media_type,
                byteLength: Number(row.byte_length),
                sha256: row.sha256,
                status: row.status,
                expiresAt: row.expires_at,
                finalizedAt: row.finalized_at,
                deletedAt: row.deleted_at,
              };
        }),
      expireArtifact: (artifactId) =>
        withOwner(async (client) => {
          await client.query(
            `update app.artifacts set expires_at=clock_timestamp()-interval '1 minute'
              where workspace_id=$1 and id=$2`,
            [workspaceId, artifactId],
          );
        }),
      close: () => resources.close(),
    });
  } catch (error: unknown) {
    return rethrowFixtureSetupFailure(resources, error);
  }
}

export function mutationHeaders(
  cookies: SessionCookies,
  idempotencyKey: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    cookie: cookies.cookieHeader,
    'x-csrf-token': cookies.csrf,
    'idempotency-key': idempotencyKey,
    ...extra,
  };
}

export function expectProblem(
  response: Readonly<{
    statusCode: number;
    payload: string;
    headers: Readonly<Record<string, unknown>>;
    json(): unknown;
  }>,
  status: number,
  code?: string,
): void {
  expect(response.statusCode, response.payload).toBe(status);
  expect(String(response.headers['content-type'])).toContain(
    'application/problem+json',
  );
  if (code !== undefined)
    expect(response.json()).toMatchObject({
      type: `urn:pertexo:problem:${code}`,
      status,
      code,
    });
}

async function resolveIdentity(
  database: IdentityWorkspaceDatabase,
  subject: string,
) {
  return {
    user: await database.createUser({
      email: `${subject}-${randomUUID()}@${emailDomain}`,
      displayName: `Artifact ${subject}`,
    }),
  };
}

function artifactApiConfig(): ApiConfig {
  return {
    artifacts: artifactStoreConfig(),
    database: artifactTransferDatabaseConfig,
    host: '127.0.0.1',
    identity: {
      publicWebOrigin: 'https://api.integration.test',
      session: {
        ttlMillis: 300_000,
        secureCookie: true,
        sameSite: 'lax',
      },
      betterAuth: {
        secret: 'artifact-transfer-integration-secret-with-32-plus-characters',
        mailMode: 'local',
        providers: {},
      },
    },
    nodeEnv: 'test',
    observability: {
      environment: 'test',
      logLevel: 'silent',
      otlpHeaders: {},
      serviceName: 'pertexo-api',
      serviceVersion: 'artifact-transfer-integration',
    },
    port: 3000,
    redisUrl,
  };
}

function artifactStoreConfig(): ArtifactStoreConfig {
  const required = (name: keyof typeof requiredArtifactEnvironment): string => {
    const value = requiredArtifactEnvironment[name];
    if (value === undefined || value.trim() === '')
      throw new Error(`Missing artifact integration setting ${name}`);
    return value;
  };
  return {
    accessKeyId: required('ARTIFACT_STORE_ACCESS_KEY_ID'),
    bucket: required('ARTIFACT_STORE_BUCKET'),
    endpoint: required('ARTIFACT_STORE_ENDPOINT'),
    forcePathStyle: true,
    maxObjectBytes: Number(process.env.ARTIFACT_MAX_BYTES ?? 5 * 1024 ** 3),
    region: required('ARTIFACT_STORE_REGION'),
    requestTimeoutMs: Number(
      process.env.ARTIFACT_STORE_REQUEST_TIMEOUT_MS ?? 5_000,
    ),
    secretAccessKey: required('ARTIFACT_STORE_SECRET_ACCESS_KEY'),
  };
}

async function withRoleClient<T>(
  pool: Pool,
  role: string,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role "${role.replaceAll('"', '""')}"`);
    await client.query("select set_config('app.workspace_id',$1,true)", [
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

function databaseUrl(base: string, databaseName: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function databaseNameFromUrl(): string {
  if (apiUrl === undefined) throw new Error('DATABASE_URL is required');
  return new URL(apiUrl).pathname.slice(1);
}
