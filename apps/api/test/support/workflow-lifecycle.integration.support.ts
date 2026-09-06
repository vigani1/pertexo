import { randomUUID } from 'node:crypto';
import {
  workflowRetainedExecutableChecksum,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model/graph';

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
import type {
  OidcAuthorizationRequest,
  OidcProviderPort,
} from '../../src/identity/index.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import { createApiApplication } from '../../src/app.js';
import { createOidcSecretEncryptionAdapter } from '../../src/identity-infrastructure/index.js';
import { Pool, type PoolClient } from 'pg';
import { expect } from 'vitest';

const apiUrl = process.env.DATABASE_API_URL;
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@127.0.0.1:5432/pertexo';
const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@127.0.0.1:6379/0';
const issuer = `https://${randomUUID()}.workflow-lifecycle.integration.test`;
const clientId = 'workflow-lifecycle-real-api';
const encryptionKey = Buffer.alloc(32, 0x6b).toString('base64');

export const workflowLifecycleIntegrationEnabled =
  process.env.API_IDENTITY_INTEGRATION === 'true' && apiUrl !== undefined;

export const workflowLifecycleDatabaseConfig = parseDatabaseConfig({
  connectionString:
    apiUrl ?? 'postgresql://invalid:invalid@127.0.0.1:5432/invalid',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 8,
  ownerRole,
});

export type SessionCookies = Readonly<{
  rawSession: string;
  csrf: string;
  cookieHeader: string;
}>;

export type LifecycleWorkflowIds = Readonly<{
  unpublished: string;
  published: string;
  publishedVersion: string;
  run: string;
}>;

export type WorkflowHistory = Readonly<{
  draft: Readonly<{
    revision: number;
    graph: unknown;
    schemaVersion: number;
  }>;
  versions: readonly Readonly<{
    id: string;
    checksum: string;
    graph: unknown;
    versionNumber: number;
  }>[];
  runs: readonly Readonly<{
    id: string;
    status: string;
    workflowVersionId: string;
  }>[];
}>;

export type WorkflowLifecycleState = Readonly<{
  lifecycleStatus: 'active' | 'archived';
  lifecycleRevision: number;
  activationStatus:
    | 'inactive'
    | 'activating'
    | 'active'
    | 'deactivating'
    | 'degraded'
    | 'error';
  publishedVersionId: string | null;
}>;

export type WorkflowLifecycleApiFixture = Readonly<{
  application: Awaited<ReturnType<typeof createApiApplication>>;
  workspaceDatabase: WorkspaceDatabase;
  identityDatabase: IdentityWorkspaceDatabase;
  workspaceId: string;
  ownerUserId: string;
  operatorUserId: string;
  viewerUserId: string;
  ids: LifecycleWorkflowIds;
  login(subject: 'owner' | 'operator' | 'viewer'): Promise<SessionCookies>;
  withOwner<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  setWorkspaceStatus(
    status: 'active' | 'suspended' | 'pending_deletion',
  ): Promise<void>;
  readLifecycle(workflowId: string): Promise<WorkflowLifecycleState>;
  readHistory(workflowId: string): Promise<WorkflowHistory>;
  close(): Promise<void>;
}>;

class FakeOidcProvider implements OidcProviderPort {
  private latestRequest: OidcAuthorizationRequest | undefined;

  public authorizationUrl(request: OidcAuthorizationRequest): string {
    this.latestRequest = request;
    const url = new URL(`${issuer}/authorize`);
    url.searchParams.set('client_id', request.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('scope', request.scopes.join(' '));
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
    return url.toString();
  }

  public exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) {
    void input.codeVerifier;
    void input.redirectUri;
    const request = this.latestRequest;
    if (request === undefined) throw new Error('authorization was not started');
    const subject = input.code;
    return Promise.resolve({
      issuer,
      subject,
      audience: clientId,
      nonce: request.nonce,
      email: `${subject}@${new URL(issuer).hostname}`,
      displayName: `Lifecycle ${subject}`,
      emailVerified: true,
    });
  }
}

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

export async function createWorkflowLifecycleApiFixture(): Promise<WorkflowLifecycleApiFixture> {
  const provider = new FakeOidcProvider();
  const identityDatabase = createIdentityWorkspaceDatabase(
    workflowLifecycleDatabaseConfig,
  );
  const transactions = createOidcLoginTransactionStore(
    workflowLifecycleDatabaseConfig,
    createOidcSecretEncryptionAdapter({
      current: { version: 'workflow-lifecycle-v1', key: encryptionKey },
    }),
  );
  const workspaceDatabase = createWorkspaceDatabase(
    workflowLifecycleDatabaseConfig,
  );
  const subjects = {
    owner: await resolveIdentity(identityDatabase, 'owner'),
    operator: await resolveIdentity(identityDatabase, 'operator'),
    viewer: await resolveIdentity(identityDatabase, 'viewer'),
  } as const;
  const workspaceId = randomUUID();
  const ids = {
    unpublished: randomUUID(),
    published: randomUUID(),
    publishedVersion: randomUUID(),
    run: randomUUID(),
  } as const;

  const ownerPool = new Pool({
    connectionString: databaseUrl(migrationUrl, databaseNameFromUrl()),
    max: 1,
  });
  const apiPool = new Pool({
    connectionString: workflowLifecycleDatabaseConfig.connectionString,
    max: 1,
  });
  const withOwner = async <T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => withOwnerClient(ownerPool, workspaceId, work);
  const withApi = async <T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => withApiClient(apiPool, workspaceId, work);
  try {
    await withOwner(async (client) => {
      await client.query(
        `insert into app.workspaces
           (id,name,slug,status,created_by)
         values ($1,$2,$3,'active',$4)`,
        [
          workspaceId,
          'Workflow lifecycle proof',
          `workflow-lifecycle-${randomUUID().slice(0, 12)}`,
          subjects.owner.user.id,
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
      await seedWorkflowRows(client, workspaceId, subjects.owner.user.id, ids);
    });
    await withApi(async (client) => {
      await client.query(
        `insert into app.workflow_runs
           (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
         values ($1,$2,$3,$4,'manual','succeeded')`,
        [ids.run, workspaceId, ids.published, ids.publishedVersion],
      );
    });

    const application = await createApiApplication(apiConfig(), {
      database: workspaceDatabase,
      identityOverrides: {
        provider,
        database: identityDatabase,
        transactions,
      },
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
      ownerUserId: subjects.owner.user.id,
      operatorUserId: subjects.operator.user.id,
      viewerUserId: subjects.viewer.user.id,
      ids,
      login: (subject: 'owner' | 'operator' | 'viewer') =>
        login(application, subject),
      withOwner,
      setWorkspaceStatus: (status) =>
        setWorkspaceStatusWithOwner(
          ownerPool,
          workspaceId,
          subjects.owner.user.id,
          status,
        ),
      readLifecycle: (workflowId) => readWorkflowLifecycle(withApi, workflowId),
      readHistory: (workflowId) => readWorkflowHistory(withApi, workflowId),
      close: async () => {
        await Promise.allSettled([
          application.close(),
          workspaceDatabase.close(),
          identityDatabase.close(),
          ownerPool.end(),
          apiPool.end(),
        ]);
      },
    });
  } catch (error: unknown) {
    await Promise.allSettled([
      transactions.close(),
      identityDatabase.close(),
      workspaceDatabase.close(),
      ownerPool.end(),
      apiPool.end(),
    ]);
    throw error;
  }
}

export async function closeWorkflowLifecycleApiFixture(
  fixture: WorkflowLifecycleApiFixture,
): Promise<void> {
  await fixture.close();
}

export function mutationHeaders(
  cookies: SessionCookies,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    cookie: cookies.cookieHeader,
    'x-csrf-token': cookies.csrf,
    'idempotency-key': `lifecycle-${randomUUID()}`,
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
  code: string,
): void {
  expect(response.statusCode, response.payload).toBe(status);
  expect(String(response.headers['content-type'])).toContain(
    'application/problem+json',
  );
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
    displayName: `Lifecycle ${subject}`,
  });
}

async function login(
  application: Awaited<ReturnType<typeof createApiApplication>>,
  subject: string,
): Promise<SessionCookies> {
  const start = await application.inject({
    method: 'GET',
    url: '/v1/auth/oidc/start',
  });
  expect(start.statusCode, start.payload).toBe(200);
  const state = start.json<{ authorizationUrl: string }>().authorizationUrl;
  const stateValue = new URL(state).searchParams.get('state');
  if (stateValue === null) throw new Error('OIDC state was not returned');
  const browserBinding = cookieValue(
    [String(start.headers['set-cookie'])],
    'pertexo_oidc_binding',
  );
  const callback = await application.inject({
    method: 'GET',
    url: `/v1/auth/oidc/callback?code=${encodeURIComponent(subject)}&state=${encodeURIComponent(stateValue)}`,
    headers: {
      cookie: `pertexo_oidc_binding=${encodeURIComponent(browserBinding)}`,
    },
  });
  expect(callback.statusCode, callback.payload).toBe(204);
  return sessionCookies(callback.headers['set-cookie']);
}

function sessionCookies(header: string | string[] | undefined): SessionCookies {
  const values = Array.isArray(header) ? header : [header ?? ''];
  const flattened = values.flatMap((value) => value.split(/,(?=[^;]+?=)/u));
  const rawSession = cookieValue(flattened, 'pertexo_session');
  const csrf = cookieValue(flattened, 'pertexo_csrf');
  return {
    rawSession,
    csrf,
    cookieHeader: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
  };
}

function cookieValue(values: readonly string[], name: string): string {
  const prefix = `${name}=`;
  for (const value of values) {
    const pair = value.split(';', 1)[0]?.trim();
    if (pair?.startsWith(prefix))
      return decodeURIComponent(pair.slice(prefix.length));
  }
  throw new Error(`${name} cookie was not returned`);
}

function apiConfig(): ApiConfig {
  return {
    database: workflowLifecycleDatabaseConfig,
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
        current: { version: 'workflow-lifecycle-v1', key: encryptionKey },
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
      serviceVersion: 'workflow-lifecycle-integration',
    },
    port: 3000,
    redisUrl,
  };
}

async function seedWorkflowRows(
  client: PoolClient,
  workspaceId: string,
  ownerUserId: string,
  ids: LifecycleWorkflowIds,
): Promise<void> {
  const graph = JSON.stringify({
    schemaVersion: 1,
    nodes: [],
    edges: [],
    settings: {},
  });
  const checksum = workflowRetainedExecutableChecksum(
    parseWorkflowGraphDraft(JSON.parse(graph)),
  );
  await client.query(
    `insert into app.workflows
           (id,workspace_id,name,lifecycle_status,activation_status,
            lifecycle_revision,published_version_id,created_by)
         values
           ($1,$2,'Unpublished lifecycle target','active','inactive',1,null,$3),
           ($4,$2,'Published lifecycle target','active','inactive',1,null,$3)`,
    [ids.unpublished, workspaceId, ownerUserId, ids.published],
  );
  await client.query(
    `insert into app.workflow_drafts
       (workflow_id,workspace_id,revision,schema_version,graph_json,updated_by)
     values
       ($1,$2,7,1,$3::jsonb,$4),
       ($5,$2,11,1,$3::jsonb,$4)`,
    [ids.unpublished, workspaceId, graph, ownerUserId, ids.published],
  );
  await client.query(
    `insert into app.workflow_versions
       (id,workspace_id,workflow_id,version_number,schema_version,
        graph_json,checksum,published_by)
     values ($1,$2,$3,4,1,$4::jsonb,$5,$6)`,
    [
      ids.publishedVersion,
      workspaceId,
      ids.published,
      graph,
      checksum,
      ownerUserId,
    ],
  );
  await client.query(
    `update app.workflows set published_version_id=$2 where id=$1`,
    [ids.published, ids.publishedVersion],
  );
}

async function setWorkspaceStatusWithOwner(
  ownerPool: Pool,
  workspaceId: string,
  ownerUserId: string,
  status: 'active' | 'suspended' | 'pending_deletion',
): Promise<void> {
  await withOwnerClient(ownerPool, workspaceId, async (client) => {
    if (status === 'pending_deletion') {
      await client.query(
        `update app.workspaces
         set status='pending_deletion',deletion_requested_at=clock_timestamp(),
             deletion_requested_by=$2,deletion_reason='integration test',
             purge_after=clock_timestamp()+interval '1 day'
         where id=$1`,
        [workspaceId, ownerUserId],
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
  });
}

async function readWorkflowHistory(
  withApi: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  workflowId: string,
): Promise<WorkflowHistory> {
  return withApi(async (client) => {
    const draft = await client.query<{
      revision: number;
      schema_version: number;
      graph_json: unknown;
    }>(
      `select revision,schema_version,graph_json
       from app.workflow_drafts where workflow_id=$1`,
      [workflowId],
    );
    const versions = await client.query<{
      id: string;
      checksum: string;
      graph_json: unknown;
      version_number: number;
    }>(
      `select id,checksum,graph_json,version_number
       from app.workflow_versions where workflow_id=$1
       order by version_number,id`,
      [workflowId],
    );
    const runs = await client.query<{
      id: string;
      status: string;
      workflow_version_id: string;
    }>(
      `select id,status,workflow_version_id
       from app.workflow_runs where workflow_id=$1 order by id`,
      [workflowId],
    );
    const draftRow = draft.rows[0];
    if (draftRow === undefined) throw new Error('workflow draft missing');
    return {
      draft: {
        revision: draftRow.revision,
        schemaVersion: draftRow.schema_version,
        graph: draftRow.graph_json,
      },
      versions: versions.rows.map((row) => ({
        id: row.id,
        checksum: row.checksum,
        graph: row.graph_json,
        versionNumber: row.version_number,
      })),
      runs: runs.rows.map((row) => ({
        id: row.id,
        status: row.status,
        workflowVersionId: row.workflow_version_id,
      })),
    };
  });
}

async function readWorkflowLifecycle(
  withApi: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  workflowId: string,
): Promise<WorkflowLifecycleState> {
  return withApi(async (client) => {
    const result = await client.query<{
      lifecycle_status: WorkflowLifecycleState['lifecycleStatus'];
      lifecycle_revision: number;
      activation_status: WorkflowLifecycleState['activationStatus'];
      published_version_id: string | null;
    }>(
      `select lifecycle_status,lifecycle_revision,activation_status,
              published_version_id
       from app.workflows where id=$1`,
      [workflowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('workflow lifecycle state missing');
    return {
      lifecycleStatus: row.lifecycle_status,
      lifecycleRevision: row.lifecycle_revision,
      activationStatus: row.activation_status,
      publishedVersionId: row.published_version_id,
    };
  });
}

async function withOwnerClient<T>(
  ownerPool: Pool,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role "${ownerRole.replaceAll('"', '""')}"`);
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

async function withApiClient<T>(
  apiPool: Pool,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await apiPool.connect();
  try {
    await client.query('begin');
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
  const value = workflowLifecycleDatabaseConfig.connectionString;
  return new URL(value).pathname.slice(1);
}
