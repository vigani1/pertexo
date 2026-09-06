import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  createArtifactStore,
  createDualRegionArtifactStore,
  type DualRegionArtifactStore,
} from '@pertexo/artifact-store';

import {
  createIdentityWorkspaceDatabase,
  createOidcLoginTransactionStore,
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
import { createOidcSecretEncryptionAdapter } from '../../src/identity-infrastructure/index.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import {
  createApiArtifactRuntime,
  type ApiArtifactRuntime,
} from '../../src/platform/artifacts/artifact-runtime.module.js';
import type {
  ApiConfig,
  ApiDualRegionArtifactStoreConfig,
} from '../../src/platform/config/api-config.js';
import {
  createFakeOidcProvider,
  loginThroughOidc,
  type HttpSessionCookies,
} from './real-oidc-http.fixture.js';

const apiUrl = process.env.DATABASE_API_URL;
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@127.0.0.1:5432/pertexo';
const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@127.0.0.1:6379/0';
const issuer = `https://${randomUUID()}.artifact-transfer.integration.test`;
const clientId = 'artifact-transfer-real-api';
const encryptionKey = Buffer.alloc(32, 0x7a).toString('base64');

const requiredArtifactEnvironment = {
  ARTIFACT_STORE_ACCESS_KEY_ID: process.env.ARTIFACT_STORE_ACCESS_KEY_ID,
  ARTIFACT_STORE_BUCKET: process.env.ARTIFACT_STORE_BUCKET,
  ARTIFACT_STORE_ENDPOINT: process.env.ARTIFACT_STORE_ENDPOINT,
  ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID:
    process.env.ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID,
  ARTIFACT_STORE_RECOVERY_BUCKET: process.env.ARTIFACT_STORE_RECOVERY_BUCKET,
  ARTIFACT_STORE_RECOVERY_ENDPOINT:
    process.env.ARTIFACT_STORE_RECOVERY_ENDPOINT,
  ARTIFACT_STORE_RECOVERY_REGION: process.env.ARTIFACT_STORE_RECOVERY_REGION,
  ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY:
    process.env.ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY,
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

type VerificationStore = Readonly<{
  beginDirectDownload: DualRegionArtifactStore['beginDirectDownload'];
  beginDirectUpload: DualRegionArtifactStore['beginDirectUpload'];
  checkReadiness: DualRegionArtifactStore['checkReadiness'];
  validateDirectUpload: DualRegionArtifactStore['validateDirectUpload'];
  verifyReplicas(
    input: ArtifactRequestMetadata &
      Readonly<{
        artifactId: string;
        workspaceId: string;
      }>,
  ): Promise<unknown>;
  head(
    input: Readonly<{ artifactId: string; workspaceId: string }>,
  ): Promise<unknown>;
  delete(
    input: Readonly<{ artifactId: string; workspaceId: string }>,
  ): Promise<void>;
  close(): void;
}>;

export type ArtifactStorageCallSnapshot = Readonly<{
  beginDirectDownload: number;
  beginDirectUpload: number;
  validateDirectUpload: number;
}>;

type ArtifactRegionStore = Readonly<{
  head(
    input: Readonly<{ artifactId: string; workspaceId: string }>,
  ): Promise<unknown>;
  put(
    input: Readonly<{
      artifactId: string;
      workspaceId: string;
      byteLength: number;
      mediaType: string;
      sha256: string;
      body: Readable;
    }>,
  ): Promise<unknown>;
  delete(
    input: Readonly<{ artifactId: string; workspaceId: string }>,
  ): Promise<void>;
  close(): void;
}>;

type FreshArtifactService = Readonly<{
  application: Awaited<ReturnType<typeof createApiApplication>>;
  login(subject: 'owner' | 'operator' | 'viewer'): Promise<SessionCookies>;
  close(): Promise<void>;
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
  recoveryStore: ArtifactRegionStore;
  createFreshApplication(): Promise<FreshArtifactService>;
  afterNextUploadVerification(callback: () => Promise<void>): void;
  deleteWithRecoveryFailure(
    input: Readonly<{ artifactId: string; workspaceId: string }>,
  ): Promise<void>;
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

const logLines: string[] = [];

const logger: StructuredLogger = {
  debug: (event, fields, error) => {
    captureLog(event, fields, error);
  },
  error: (event, fields, error) => {
    captureLog(event, fields, error);
  },
  fatal: (event, fields, error) => {
    captureLog(event, fields, error);
  },
  info: (event, fields, error) => {
    captureLog(event, fields, error);
  },
  trace: (event, fields, error) => {
    captureLog(event, fields, error);
  },
  warn: (event, fields, error) => {
    captureLog(event, fields, error);
  },
};

function captureLog(
  event: string,
  fields: Readonly<Record<string, unknown>> | undefined,
  error: unknown,
): void {
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
  logLines.push(`${event} ${fieldsText} ${errorText}`.trim());
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
  const provider = createFakeOidcProvider({
    issuer,
    clientId,
    displayNamePrefix: 'Artifact',
  });
  const identityDatabase = createIdentityWorkspaceDatabase(
    artifactTransferDatabaseConfig,
  );
  const transactions = createOidcLoginTransactionStore(
    artifactTransferDatabaseConfig,
    createOidcSecretEncryptionAdapter({
      current: { version: 'artifact-transfer-v1', key: encryptionKey },
    }),
  );
  const workspaceDatabase = createWorkspaceDatabase(
    artifactTransferDatabaseConfig,
  );
  const subjects = {
    owner: await resolveIdentity(identityDatabase, 'owner'),
    operator: await resolveIdentity(identityDatabase, 'operator'),
    viewer: await resolveIdentity(identityDatabase, 'viewer'),
  } as const;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const ownerPool = new Pool({
    connectionString: databaseUrl(migrationUrl, databaseNameFromUrl()),
    max: 1,
  });
  const apiPool = new Pool({
    connectionString: artifactTransferDatabaseConfig.connectionString,
    max: 1,
  });
  const apiRole =
    apiUrl === undefined
      ? 'pertexo_api'
      : decodeURIComponent(new URL(apiUrl).username);
  const configuredArtifactStore = artifactStoreConfig();
  const verificationStore = createVerificationStore(configuredArtifactStore);
  const recoveryStore = createRecoveryStore(configuredArtifactStore.recovery);
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
  let identityRuntime: ReturnType<typeof createApiIdentityRuntime> | undefined;
  let artifactRuntime: ApiArtifactRuntime | undefined;

  try {
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
    identityRuntime = createApiIdentityRuntime(
      config.identity,
      config.database,
      {
        provider,
        database: identityDatabase,
        transactions,
      },
    );
    const createdArtifactRuntime = createApiArtifactRuntime(
      config.artifacts,
      config.database,
      identityRuntime,
      { store: apiStore },
    );
    // S3Mock exposes one physical bucket region for both buckets. The store
    // remains real and dual-region finalize is exercised below; this fixture
    // bypasses only the startup region probe.
    const runtime: ApiArtifactRuntime = Object.freeze({
      ...createdArtifactRuntime,
      checkReadiness: () => Promise.resolve(),
    });
    artifactRuntime = runtime;
    const application = await createApiApplication(config, {
      database: workspaceDatabase,
      identityRuntime,
      artifactRuntime: runtime,
      rateLimitConsumer: {
        consume: () => Promise.resolve({ allowed: true as const }),
      },
      logger,
      telemetry,
    });
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
      recoveryStore,
      createFreshApplication: () => createFreshArtifactService(config),
      afterNextUploadVerification: (callback) => {
        afterNextUploadVerification = callback;
      },
      deleteWithRecoveryFailure: (input) =>
        deleteWithRecoveryFailure(configuredArtifactStore, input),
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
      readLogText: () => logLines.join('\n'),
      readStorageCalls: () => Object.freeze({ ...storageCalls }),
      login: (subject: 'owner' | 'operator' | 'viewer') =>
        loginThroughOidc(application, subject),
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
      close: async () => {
        await Promise.allSettled([
          application.close(),
          Promise.resolve().then(() => {
            verificationStore.close();
          }),
          Promise.resolve().then(() => {
            recoveryStore.close();
          }),
          workspaceDatabase.close(),
          identityDatabase.close(),
          transactions.close(),
          ownerPool.end(),
          apiPool.end(),
        ]);
      },
    });
  } catch (error: unknown) {
    await Promise.allSettled([
      artifactRuntime?.close(),
      identityRuntime?.close(),
      Promise.resolve().then(() => {
        verificationStore.close();
      }),
      Promise.resolve().then(() => {
        recoveryStore.close();
      }),
      transactions.close(),
      identityDatabase.close(),
      workspaceDatabase.close(),
      ownerPool.end(),
      apiPool.end(),
    ]);
    throw error;
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
  return database.resolveOrCreateIdentity({
    issuer,
    providerSubject: subject,
    email: `${subject}@${new URL(issuer).hostname}`,
    displayName: `Artifact ${subject}`,
  });
}

function artifactApiConfig(): ApiConfig {
  return {
    artifacts: artifactStoreConfig(),
    database: artifactTransferDatabaseConfig,
    host: '127.0.0.1',
    identity: {
      oidc: {
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        jwksUri: `${issuer}/jwks`,
        clientId,
        redirectUri: 'https://api.integration.test/v1/auth/oidc/callback',
        scopes: ['openid', 'profile', 'email'],
        allowedAlgorithms: ['RS256'],
        timeoutMillis: 5_000,
        transactionTtlMillis: 30_000,
        allowInsecureHttpForTests: false,
      },
      secretEncryption: {
        current: { version: 'artifact-transfer-v1', key: encryptionKey },
        previous: [],
      },
      session: {
        ttlMillis: 300_000,
        secureCookie: true,
        sameSite: 'lax',
      },
    },
    nodeCompatibilityCohort: 'core',
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

function artifactStoreConfig(): ApiDualRegionArtifactStoreConfig {
  const required = (name: keyof typeof requiredArtifactEnvironment): string => {
    const value = requiredArtifactEnvironment[name];
    if (value === undefined || value.trim() === '')
      throw new Error(`Missing artifact integration setting ${name}`);
    return value;
  };
  const maxObjectBytes = Number(
    process.env.ARTIFACT_MAX_BYTES ?? 5 * 1024 ** 3,
  );
  return {
    primary: {
      accessKeyId: required('ARTIFACT_STORE_ACCESS_KEY_ID'),
      bucket: required('ARTIFACT_STORE_BUCKET'),
      endpoint: required('ARTIFACT_STORE_ENDPOINT'),
      forcePathStyle: true,
      maxObjectBytes,
      region: required('ARTIFACT_STORE_REGION'),
      requestTimeoutMs: Number(
        process.env.ARTIFACT_STORE_REQUEST_TIMEOUT_MS ?? 5_000,
      ),
      secretAccessKey: required('ARTIFACT_STORE_SECRET_ACCESS_KEY'),
    },
    recovery: {
      accessKeyId: required('ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID'),
      bucket: required('ARTIFACT_STORE_RECOVERY_BUCKET'),
      endpoint: required('ARTIFACT_STORE_RECOVERY_ENDPOINT'),
      forcePathStyle: true,
      maxObjectBytes,
      region: required('ARTIFACT_STORE_RECOVERY_REGION'),
      requestTimeoutMs: Number(
        process.env.ARTIFACT_STORE_RECOVERY_REQUEST_TIMEOUT_MS ?? 5_000,
      ),
      secretAccessKey: required('ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY'),
    },
  };
}

function createVerificationStore(
  config: ApiDualRegionArtifactStoreConfig,
): VerificationStore {
  return createDualRegionArtifactStore(config.primary, config.recovery);
}

function createRecoveryStore(
  config: ApiDualRegionArtifactStoreConfig['recovery'],
): ArtifactRegionStore {
  const store = createArtifactStore(config);
  return Object.freeze({
    close: () => {
      store.close();
    },
    delete: (input) => store.delete(input),
    head: (input) => store.head(input),
    put: (input) => store.put(input),
  });
}

async function createFreshArtifactService(
  config: ApiConfig,
): Promise<FreshArtifactService> {
  if (config.identity === undefined || config.artifacts === undefined)
    throw new Error('Artifact integration config is incomplete');
  const provider = createFakeOidcProvider({
    issuer,
    clientId,
    displayNamePrefix: 'Artifact',
  });
  const identityDatabase = createIdentityWorkspaceDatabase(
    artifactTransferDatabaseConfig,
  );
  const transactions = createOidcLoginTransactionStore(
    artifactTransferDatabaseConfig,
    createOidcSecretEncryptionAdapter({
      current: { version: 'artifact-transfer-v1', key: encryptionKey },
    }),
  );
  const workspaceDatabase = createWorkspaceDatabase(
    artifactTransferDatabaseConfig,
  );
  let identityRuntime: ReturnType<typeof createApiIdentityRuntime> | undefined;
  let artifactRuntime: ApiArtifactRuntime | undefined;
  try {
    identityRuntime = createApiIdentityRuntime(
      config.identity,
      config.database,
      {
        provider,
        database: identityDatabase,
        transactions,
      },
    );
    const createdArtifactRuntime = createApiArtifactRuntime(
      config.artifacts,
      config.database,
      identityRuntime,
    );
    const runtime: ApiArtifactRuntime = Object.freeze({
      ...createdArtifactRuntime,
      checkReadiness: () => Promise.resolve(),
    });
    artifactRuntime = runtime;
    const application = await createApiApplication(config, {
      database: workspaceDatabase,
      identityRuntime,
      artifactRuntime: runtime,
      rateLimitConsumer: {
        consume: () => Promise.resolve({ allowed: true as const }),
      },
      logger,
      telemetry,
    });
    return Object.freeze({
      application,
      login: (subject: 'owner' | 'operator' | 'viewer') =>
        loginThroughOidc(application, subject),
      close: () => application.close(),
    });
  } catch (error: unknown) {
    await Promise.allSettled([
      artifactRuntime?.close(),
      identityRuntime?.close(),
      workspaceDatabase.close(),
      identityDatabase.close(),
      transactions.close(),
    ]);
    throw error;
  }
}

async function deleteWithRecoveryFailure(
  config: ApiDualRegionArtifactStoreConfig,
  input: Readonly<{ artifactId: string; workspaceId: string }>,
): Promise<void> {
  const primary = createArtifactStore(config.primary);
  const recovery = createArtifactStore(config.recovery);
  const dual = createDualRegionArtifactStore(primary, recovery, {
    artifactOwnership: 'owned',
  });
  recovery.close();
  try {
    await dual.delete(input);
  } finally {
    dual.close();
  }
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
  if (apiUrl === undefined) throw new Error('DATABASE_API_URL is required');
  return new URL(apiUrl).pathname.slice(1);
}
