import { randomUUID } from 'node:crypto';
import { createArtifactStore } from '@pertexo/artifact-store';
import {
  createArtifactUploadStore,
  createFormUploadStore,
} from '@pertexo/core/artifacts';
import { createIdentityWorkspaceDatabase } from '@pertexo/core/testing';
import { createWorkspaceDatabase } from '@pertexo/database/testing';

import { Pool, type PoolClient } from 'pg';

import { createTestApiApplication } from '../../support/api-application.js';
import { createApiIdentityRuntime } from '../../../src/platform/identity/runtime.module.js';
import type { ApiArtifactRuntime } from '../../../src/platform/artifacts/runtime.module.js';

import { issueBrowserSession } from '../../webhooks/support/browser-session.fixture.js';
import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../../browser/harness/resource-owner.js';
import {
  apiUrl,
  migrationUrl,
  ownerRole,
  artifactTransferIntegrationEnabled,
  artifactTransferDatabaseConfig,
} from './environment.js';
import type {
  ArtifactFixtureRole,
  VerificationStore,
  ArtifactTransferApiFixture,
} from './contract.js';
import { createFixtureLogCapture, telemetry } from './logging.js';
import { resolveIdentity } from './http.js';
import { artifactApiConfig, artifactStoreConfig } from './settings.js';
import {
  withRoleClient,
  databaseUrl,
  databaseNameFromUrl,
} from './database.js';

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
      getStream: (...args: Parameters<VerificationStore['getStream']>) =>
        verificationStore.getStream(...args),
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
      await createApiIdentityRuntime(config.identity, config.database),
      (runtime) => runtime.close(),
    );
    const uploads = createArtifactUploadStore(config.database);
    const formUploads = createFormUploadStore(config.database);
    // S3Mock reports its own bucket region. The store remains real; this
    // fixture bypasses only the startup region probe.
    const runtime: ApiArtifactRuntime = Object.freeze({
      dependencies: Object.freeze({
        authorization: identityRuntime.dependencies.authorization,
        database: uploads,
        formUploads,
        store: apiStore,
      }),
      checkReadiness: () => Promise.resolve(),
      close: async () => {
        apiStore.close();
        await Promise.all([uploads.close(), formUploads.close()]);
      },
    });
    resources.acquire('artifact runtime', runtime, (selected) =>
      selected.close(),
    );
    resources.transfer(verificationStore);
    const application = resources.acquire(
      'API application',
      await createTestApiApplication(config, {
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
      login: (subject: ArtifactFixtureRole) =>
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
