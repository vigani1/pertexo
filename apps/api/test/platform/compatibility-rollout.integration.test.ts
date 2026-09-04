import { createHash, randomUUID } from 'node:crypto';

import {
  CONNECTION_AUTH_TYPE,
  CompatibilityReleaseMismatchError,
  createConnectionDatabase,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  createIdentityWorkspaceDatabase,
  createWorkflowIntegrationUsageDatabase,
  migrateDatabase,
  parseDatabaseConfig,
  WorkflowDefinitionPlacementError,
} from '@pertexo/database/testing';
import {
  HTTP_REQUEST_CONNECTION_SLOT,
  HTTP_REQUEST_DEFINITION,
} from '@pertexo/integrations';
import {
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import { CORE_REGISTRY_RELEASE_SUPPORT } from '@pertexo/nodes-core';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/graph';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCoreWorkflowAuthoringDatabase } from '../../src/platform/workflow/workflow-runtime.module.js';
import { createPostgresWorkflowRunPersistence } from '../../src/workflow-runs/postgres-persistence.js';
import { dropDisconnectedDatabase } from '../support/disposable-database.js';

const migrationBaseUrl = process.env.DATABASE_MIGRATION_URL;
const apiBaseUrl = process.env.DATABASE_API_URL;
const workerBaseUrl = process.env.DATABASE_WORKER_URL;
const enabled =
  process.env.API_COMPATIBILITY_ROLLOUT_INTEGRATION === 'true' &&
  migrationBaseUrl !== undefined &&
  apiBaseUrl !== undefined &&
  workerBaseUrl !== undefined;
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const databaseName = `pertexo_test_compatibility_rollout_${randomUUID().replaceAll('-', '')}`;

function namedDatabaseUrl(base: string, name: string): string {
  const value = new URL(base);
  value.pathname = `/${name}`;
  return value.toString();
}

const migrationUrl =
  migrationBaseUrl === undefined
    ? undefined
    : namedDatabaseUrl(migrationBaseUrl, databaseName);
const apiUrl =
  apiBaseUrl === undefined
    ? undefined
    : namedDatabaseUrl(apiBaseUrl, databaseName);
const workerUrl =
  workerBaseUrl === undefined
    ? undefined
    : namedDatabaseUrl(workerBaseUrl, databaseName);

async function createDisposableDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker`,
    );
  } finally {
    await admin.end();
  }
  if (migrationUrl === undefined)
    throw new Error('Compatibility rollout migration URL is unavailable');
  await migrateDatabase({
    apiRuntimeRole: process.env.POSTGRES_API_RUNTIME_USER ?? 'pertexo_api',
    connectionString: migrationUrl,
    dispatcherRole:
      process.env.POSTGRES_DISPATCHER_USER ?? 'pertexo_dispatcher',
    lifecycleCommandRole:
      process.env.POSTGRES_LIFECYCLE_COMMAND_USER ??
      'pertexo_lifecycle_command',
    maintenanceRole:
      process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance',
    operatorRole: process.env.POSTGRES_OPERATOR_USER ?? 'pertexo_operator',
    ownerRole: process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner',
    workerRuntimeRole:
      process.env.POSTGRES_WORKER_RUNTIME_USER ?? 'pertexo_worker',
  });
}

async function dropDisposableDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
}

const databaseConfig = (connectionString: string) =>
  parseDatabaseConfig({
    connectionString,
    max: 1,
    ownerRole: process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner',
    workerRuntimeRole:
      process.env.POSTGRES_WORKER_RUNTIME_USER ?? 'pertexo_worker',
  });

async function activatePreparedRelease(
  maintenance: ReturnType<typeof createCompatibilityReleaseMaintenance>,
  apiProbe: ReturnType<typeof createCompatibilityReleaseReadinessProbe>,
  workerProbe: ReturnType<typeof createCompatibilityReleaseReadinessProbe>,
  predecessor: Parameters<
    ReturnType<typeof createCompatibilityReleaseMaintenance>['prepare']
  >[0]['expectedPredecessor'],
  target: Parameters<
    ReturnType<typeof createCompatibilityReleaseMaintenance>['prepare']
  >[0]['target'],
  label: string,
) {
  const deploymentId = `${label}-${randomUUID()}`;
  const approvalId = randomUUID();
  const apiArtifact = `${label}-api`;
  const workerArtifact = `${label}-worker`;
  await maintenance.prepare({
    actorId: 'phase4-rollout-integration',
    actorKind: 'deployment',
    expectedPredecessor: predecessor,
    reason: `Prepare ${label}`,
    target,
  });
  await expect(apiProbe.checkTarget(target)).resolves.toMatchObject({
    role: 'pertexo_api',
  });
  await expect(workerProbe.checkTarget(target)).resolves.toMatchObject({
    role: 'pertexo_worker',
  });
  await maintenance.recordPreactivation({
    artifactId: apiArtifact,
    checkId: randomUUID(),
    deploymentId,
    roleKind: 'api',
    target,
  });
  await maintenance.recordPreactivation({
    artifactId: workerArtifact,
    checkId: randomUUID(),
    deploymentId,
    roleKind: 'worker',
    target,
  });
  await maintenance.approve({
    actorId: 'phase4-rollout-integration',
    approvalId,
    deploymentId,
    reason: `Approve ${label}`,
    requiredApiArtifacts: [apiArtifact],
    requiredWorkerArtifacts: [workerArtifact],
    target,
  });
  await maintenance.activate({
    activationId: randomUUID(),
    actorId: 'phase4-rollout-integration',
    actorKind: 'deployment',
    approvalId,
    expectedPredecessor: predecessor,
    reason: `Activate ${label}`,
  });
}

describe.runIf(enabled)('additive compatibility release rollout', () => {
  beforeAll(createDisposableDatabase, 60_000);
  afterAll(dropDisposableDatabase);

  it('preactivates the complete API/worker cohort before atomically activating the target', async () => {
    const support = createExecutableCompatibilityReleaseSupport(
      CORE_REGISTRY_RELEASE_SUPPORT.map(composeExecutableCompatibilityRelease),
    );
    const stagingSupport = createExecutableCompatibilityReleaseSupport(
      platformRegistryReleaseSupport('http_staging').map(
        composeExecutableCompatibilityRelease,
      ),
    );
    const activationSupport = createExecutableCompatibilityReleaseSupport(
      platformRegistryReleaseSupport('http_activation').map(
        composeExecutableCompatibilityRelease,
      ),
    );
    const [currentDescription, targetDescription] = support.descriptions;
    const [stagingPredecessor, stagingTarget] = stagingSupport.descriptions;
    const [activationPredecessor, activationTarget] =
      activationSupport.descriptions;
    if (
      currentDescription === undefined ||
      targetDescription === undefined ||
      stagingPredecessor === undefined ||
      stagingTarget === undefined ||
      activationPredecessor === undefined ||
      activationTarget === undefined
    )
      throw new Error('Rolling release support is incomplete');
    const maintenance = createCompatibilityReleaseMaintenance(
      databaseConfig(migrationUrl ?? ''),
    );
    const apiProbe = createCompatibilityReleaseReadinessProbe(
      databaseConfig(apiUrl ?? ''),
      support.descriptions,
    );
    const workerProbe = createCompatibilityReleaseReadinessProbe(
      databaseConfig(workerUrl ?? ''),
      support.descriptions,
    );
    const oldApiProbe = createCompatibilityReleaseReadinessProbe(
      databaseConfig(apiUrl ?? ''),
      [currentDescription],
    );
    const stagingApiProbe = createCompatibilityReleaseReadinessProbe(
      databaseConfig(apiUrl ?? ''),
      stagingSupport.descriptions,
    );
    const stagingWorkerProbe = createCompatibilityReleaseReadinessProbe(
      databaseConfig(workerUrl ?? ''),
      stagingSupport.descriptions,
    );
    const activationApiProbe = createCompatibilityReleaseReadinessProbe(
      databaseConfig(apiUrl ?? ''),
      activationSupport.descriptions,
    );
    const activationWorkerProbe = createCompatibilityReleaseReadinessProbe(
      databaseConfig(workerUrl ?? ''),
      activationSupport.descriptions,
    );
    const identity = createIdentityWorkspaceDatabase(
      databaseConfig(apiUrl ?? ''),
    );
    const authoring = createCoreWorkflowAuthoringDatabase(
      databaseConfig(apiUrl ?? ''),
    );
    const stagingAuthoring = createCoreWorkflowAuthoringDatabase(
      databaseConfig(apiUrl ?? ''),
      'http_staging',
    );
    const activationAuthoring = createCoreWorkflowAuthoringDatabase(
      databaseConfig(apiUrl ?? ''),
      'http_activation',
    );
    const connections = createConnectionDatabase(databaseConfig(apiUrl ?? ''));
    const usage = createWorkflowIntegrationUsageDatabase(
      databaseConfig(apiUrl ?? ''),
    );
    const activationRunPersistence = createPostgresWorkflowRunPersistence(
      databaseConfig(apiUrl ?? ''),
      undefined,
      undefined,
      'http_activation',
    );
    const deploymentId = `compatibility-rollout-${randomUUID()}`;
    const approvalId = randomUUID();
    try {
      await maintenance.prepare({
        actorId: 'compatibility-rollout-integration',
        actorKind: 'deployment',
        expectedPredecessor: currentDescription,
        reason: 'Prepare the real lifecycle-only additive target',
        target: targetDescription,
      });
      await expect(
        apiProbe.checkTarget(targetDescription),
      ).resolves.toMatchObject({ role: 'pertexo_api' });
      await expect(
        workerProbe.checkTarget(targetDescription),
      ).resolves.toMatchObject({ role: 'pertexo_worker' });
      await maintenance.recordPreactivation({
        artifactId: 'api-rollout-a',
        checkId: randomUUID(),
        deploymentId,
        roleKind: 'api',
        target: targetDescription,
      });
      await maintenance.recordPreactivation({
        artifactId: 'worker-rollout-a',
        checkId: randomUUID(),
        deploymentId,
        roleKind: 'worker',
        target: targetDescription,
      });
      await maintenance.approve({
        actorId: 'compatibility-rollout-integration',
        approvalId,
        deploymentId,
        reason: 'Approve the exact preactivated API and worker cohort',
        requiredApiArtifacts: ['api-rollout-a'],
        requiredWorkerArtifacts: ['worker-rollout-a'],
        target: targetDescription,
      });
      const actorId = randomUUID();
      const user = await identity.createUser({
        id: actorId,
        displayName: 'Compatibility rollout',
        email: `rollout-${actorId}@example.test`,
      });
      const workspace = await identity.createWorkspaceWithOwner({
        id: randomUUID(),
        idempotencyKey: `workspace-${actorId}`,
        name: 'Compatibility rollout',
        ownerUserId: user.id,
        slug: `rollout-${actorId}`,
      });
      const created = await authoring.createWorkflow({
        actorId,
        emptyGraph: {
          schemaVersion: 1,
          settings: {},
          nodes: [],
          edges: [],
        },
        id: randomUUID(),
        idempotencyKey: `workflow-${actorId}`,
        name: 'Retained definition workflow',
        workspaceId: workspace.id,
      });
      const preactivationDraft = await authoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: {
          schemaVersion: 1,
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
              id: 'terminate',
              definition: { key: 'core.terminate', version: 1 },
              position: { x: 1, y: 0 },
              configVersion: 1,
              config: {},
              inputMappings: {
                result: {
                  kind: 'node_output',
                  nodeId: 'manual',
                  path: '$',
                },
              },
              connectionRefs: {},
            },
          ],
          edges: [
            {
              id: 'manual-terminate',
              source: { nodeId: 'manual', port: 'out' },
              target: { nodeId: 'terminate', port: 'in' },
            },
          ],
        },
        workflowId: created.workflowId,
        workspaceId: workspace.id,
      });
      expect(preactivationDraft.compatibility.fingerprint).toBe(
        currentDescription.fingerprint,
      );
      await maintenance.activate({
        activationId: randomUUID(),
        actorId: 'compatibility-rollout-integration',
        actorKind: 'deployment',
        approvalId,
        expectedPredecessor: currentDescription,
        reason: 'Activate only after durable cohort approval',
      });

      await expect(apiProbe.checkCurrent()).resolves.toMatchObject({
        role: 'pertexo_api',
      });
      await expect(workerProbe.checkCurrent()).resolves.toMatchObject({
        role: 'pertexo_worker',
      });
      await expect(oldApiProbe.checkCurrent()).rejects.toBeInstanceOf(
        CompatibilityReleaseMismatchError,
      );
      const retainedDraft = await authoring.getDraft(
        workspace.id,
        created.workflowId,
        actorId,
      );
      if (retainedDraft === null)
        throw new Error('Retained rollout draft is unavailable');
      expect(retainedDraft.compatibility.fingerprint).toBe(
        targetDescription.fingerprint,
      );
      const published = await authoring.publishWorkflow({
        actorId,
        idempotencyKey: `publish-${actorId}`,
        representationTag: workflowDraftRepresentationTag({
          workflowId: created.workflowId,
          revision: retainedDraft.revision,
          graph: retainedDraft.graphJson,
          compatibilityFingerprint: retainedDraft.compatibility.fingerprint,
        }),
        requestHash: 'a'.repeat(64),
        workflowId: created.workflowId,
        workspaceId: workspace.id,
      });
      expect(published.version.checksum).toMatch(/^wf:v2:sha256:/u);

      const postactivation = await authoring.createWorkflow({
        actorId,
        emptyGraph: {
          schemaVersion: 1,
          settings: {},
          nodes: [],
          edges: [],
        },
        id: randomUUID(),
        idempotencyKey: `postactivation-workflow-${actorId}`,
        name: 'Blocked deprecated placement',
        workspaceId: workspace.id,
      });
      await expect(
        authoring.saveDraft({
          actorId,
          expectedRevision: 1,
          graphJson: {
            schemaVersion: 1,
            settings: {},
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
            ],
            edges: [],
          },
          workflowId: postactivation.workflowId,
          workspaceId: workspace.id,
        }),
      ).rejects.toBeInstanceOf(WorkflowDefinitionPlacementError);
      await expect(
        authoring.saveDraft({
          actorId,
          expectedRevision: 1,
          graphJson: {
            schemaVersion: 1,
            settings: {},
            nodes: [
              {
                id: 'duplicate',
                definition: { key: 'core.manual', version: 1 },
                position: { x: 0, y: 0 },
                configVersion: 1,
                config: {},
                inputMappings: {},
                connectionRefs: {},
              },
              {
                id: 'duplicate',
                definition: { key: 'core.set', version: 1 },
                position: { x: 1, y: 0 },
                configVersion: 1,
                config: {},
                inputMappings: {},
                connectionRefs: {},
              },
            ],
            edges: [],
          },
          workflowId: postactivation.workflowId,
          workspaceId: workspace.id,
        }),
      ).rejects.toBeInstanceOf(WorkflowDefinitionPlacementError);
      await expect(
        authoring.saveDraft({
          actorId,
          expectedRevision: 1,
          graphJson: {
            schemaVersion: 1,
            settings: {},
            nodes: [
              {
                id: 'container',
                definition: { key: 'core.set', version: 1 },
                position: { x: 0, y: 0 },
                configVersion: 1,
                config: {},
                inputMappings: {},
                connectionRefs: {},
                structured: {
                  kind: 'for_each',
                  maxIterations: 1,
                  maxConcurrency: 1,
                  body: {
                    schemaVersion: 1,
                    settings: {},
                    inputPorts: [],
                    outputPorts: [],
                    nodes: [
                      {
                        id: 'nested-duplicate',
                        definition: { key: 'core.manual', version: 1 },
                        position: { x: 0, y: 0 },
                        configVersion: 1,
                        config: {},
                        inputMappings: {},
                        connectionRefs: {},
                      },
                      {
                        id: 'nested-duplicate',
                        definition: { key: 'core.set', version: 1 },
                        position: { x: 1, y: 0 },
                        configVersion: 1,
                        config: {},
                        inputMappings: {},
                        connectionRefs: {},
                      },
                    ],
                    edges: [],
                  },
                },
              },
            ],
            edges: [],
          },
          workflowId: postactivation.workflowId,
          workspaceId: workspace.id,
        }),
      ).rejects.toBeInstanceOf(WorkflowDefinitionPlacementError);
      await expect(
        authoring.getDraft(workspace.id, postactivation.workflowId, actorId),
      ).resolves.toMatchObject({ revision: 1, graphJson: { nodes: [] } });

      await activatePreparedRelease(
        maintenance,
        stagingApiProbe,
        stagingWorkerProbe,
        stagingPredecessor,
        stagingTarget,
        'phase4-http-staging',
      );
      await expect(stagingApiProbe.checkCurrent()).resolves.toMatchObject({
        role: 'pertexo_api',
      });
      await expect(stagingWorkerProbe.checkCurrent()).resolves.toMatchObject({
        role: 'pertexo_worker',
      });
      await expect(apiProbe.checkCurrent()).rejects.toBeInstanceOf(
        CompatibilityReleaseMismatchError,
      );

      const stagedHttpWorkflow = await stagingAuthoring.createWorkflow({
        actorId,
        emptyGraph: {
          schemaVersion: 1,
          settings: {},
          nodes: [],
          edges: [],
        },
        id: randomUUID(),
        idempotencyKey: `staged-http-${actorId}`,
        name: 'HTTP remains hidden while staged',
        workspaceId: workspace.id,
      });
      await expect(
        stagingAuthoring.saveDraft({
          actorId,
          expectedRevision: 1,
          graphJson: {
            schemaVersion: 1,
            settings: {},
            nodes: [
              {
                id: 'http',
                definition: HTTP_REQUEST_DEFINITION,
                position: { x: 0, y: 0 },
                configVersion: 1,
                config: {
                  method: 'GET',
                  url: 'https://provider.example.test/v1/items',
                  headers: { accept: 'application/json' },
                  timeoutMillis: 10_000,
                  maxRedirects: 2,
                  maxResponseBytes: 1_048_576,
                  inlineResponseBytes: 65_536,
                },
                inputMappings: {},
                connectionRefs: {
                  [HTTP_REQUEST_CONNECTION_SLOT]: randomUUID(),
                },
              },
            ],
            edges: [],
          },
          workflowId: stagedHttpWorkflow.workflowId,
          workspaceId: workspace.id,
        }),
      ).rejects.toBeInstanceOf(WorkflowDefinitionPlacementError);

      await activatePreparedRelease(
        maintenance,
        activationApiProbe,
        activationWorkerProbe,
        activationPredecessor,
        activationTarget,
        'phase4-http-activation',
      );
      await expect(activationApiProbe.checkCurrent()).resolves.toMatchObject({
        role: 'pertexo_api',
      });
      await expect(activationWorkerProbe.checkCurrent()).resolves.toMatchObject(
        { role: 'pertexo_worker' },
      );
      await expect(stagingApiProbe.checkCurrent()).rejects.toBeInstanceOf(
        CompatibilityReleaseMismatchError,
      );

      const connectionId = randomUUID();
      await connections.createConnection({
        workspaceId: workspace.id,
        actorId,
        connectionId,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: 'HTTP rollout proof',
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        sealed: {
          schemaVersion: 1,
          kmsKeyReference:
            'arn:aws:kms:eu-central-1:123456789012:key/rollout-proof',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('rollout-proof').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
        idempotencyKey: `http-connection-${connectionId}`,
        requestHash: createHash('sha256').update(connectionId).digest('hex'),
      });
      const activeHttpWorkflow = await activationAuthoring.createWorkflow({
        actorId,
        emptyGraph: {
          schemaVersion: 1,
          settings: {},
          nodes: [],
          edges: [],
        },
        id: randomUUID(),
        idempotencyKey: `active-http-${actorId}`,
        name: 'HTTP active publication',
        workspaceId: workspace.id,
      });
      const activeHttpDraft = await activationAuthoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: {
          schemaVersion: 1,
          settings: { maxRunDurationMs: 60_000 },
          nodes: [
            {
              id: 'http',
              definition: HTTP_REQUEST_DEFINITION,
              position: { x: 0, y: 0 },
              configVersion: 1,
              config: {
                method: 'GET',
                url: 'https://provider.example.test/v1/items',
                headers: { accept: 'application/json' },
                timeoutMillis: 10_000,
                maxRedirects: 2,
                maxResponseBytes: 1_048_576,
                inlineResponseBytes: 65_536,
              },
              inputMappings: {},
              connectionRefs: {
                [HTTP_REQUEST_CONNECTION_SLOT]: connectionId,
              },
            },
          ],
          edges: [],
        },
        workflowId: activeHttpWorkflow.workflowId,
        workspaceId: workspace.id,
      });
      expect(activeHttpDraft.compatibility.fingerprint).toBe(
        activationTarget.fingerprint,
      );
      const activeHttpPublished = await activationAuthoring.publishWorkflow({
        actorId,
        idempotencyKey: `publish-active-http-${actorId}`,
        representationTag: workflowDraftRepresentationTag({
          workflowId: activeHttpWorkflow.workflowId,
          revision: activeHttpDraft.revision,
          graph: activeHttpDraft.graphJson,
          compatibilityFingerprint: activeHttpDraft.compatibility.fingerprint,
        }),
        requestHash: createHash('sha256')
          .update(`publish-active-http-${actorId}`)
          .digest('hex'),
        workflowId: activeHttpWorkflow.workflowId,
        workspaceId: workspace.id,
      });
      expect(activeHttpPublished.version.checksum).toMatch(/^wf:v2:sha256:/u);
      await expect(
        usage.findConnectionImpact({
          workspaceId: workspace.id,
          connectionId,
          limit: 10,
        }),
      ).resolves.toMatchObject({
        items: [
          {
            workflowVersionId: activeHttpPublished.version.id,
            providerKey: 'http',
            operationKey: 'request',
            connectionId,
          },
        ],
      });

      await expect(
        activationRunPersistence.persistence.start({
          actorId,
          workspaceId: workspace.id,
          workflowId: created.workflowId,
          idempotencyKeyHash: createHash('sha256')
            .update(`retained-run-${actorId}`)
            .digest('hex'),
          requestHash: createHash('sha256')
            .update(`retained-run-request-${actorId}`)
            .digest('hex'),
          scope: `workflow:${created.workflowId}:manual`,
        }),
      ).resolves.toMatchObject({
        replayed: false,
        run: { workflowVersionId: published.version.id },
      });

      const remainingCohorts: readonly PlatformReleaseCohort[] = [
        'condition_staging',
        'condition_activation',
        'switch_staging',
        'switch_activation',
        'parallel_staging',
        'parallel_activation',
        'merge_staging',
        'merge_activation',
        'for_each_staging',
        'for_each_activation',
        'wait_staging',
        'wait_activation',
        'slack_staging',
        'slack_activation',
        'email_staging',
        'email_activation',
      ];
      for (const cohort of remainingCohorts) {
        const rollout = createExecutableCompatibilityReleaseSupport(
          platformRegistryReleaseSupport(cohort).map(
            composeExecutableCompatibilityRelease,
          ),
        );
        const [predecessor, target] = rollout.descriptions;
        if (predecessor === undefined || target === undefined)
          throw new Error(`Incomplete rollout support for ${cohort}`);
        const cohortApiProbe = createCompatibilityReleaseReadinessProbe(
          databaseConfig(apiUrl ?? ''),
          rollout.descriptions,
        );
        const cohortWorkerProbe = createCompatibilityReleaseReadinessProbe(
          databaseConfig(workerUrl ?? ''),
          rollout.descriptions,
        );
        try {
          await activatePreparedRelease(
            maintenance,
            cohortApiProbe,
            cohortWorkerProbe,
            predecessor,
            target,
            cohort,
          );
          await expect(cohortApiProbe.checkCurrent()).resolves.toMatchObject({
            role: 'pertexo_api',
          });
          await expect(cohortWorkerProbe.checkCurrent()).resolves.toMatchObject(
            { role: 'pertexo_worker' },
          );
        } finally {
          await Promise.all([
            cohortApiProbe.close(),
            cohortWorkerProbe.close(),
          ]);
        }
      }
    } finally {
      await Promise.all([
        maintenance.close(),
        apiProbe.close(),
        workerProbe.close(),
        oldApiProbe.close(),
        stagingApiProbe.close(),
        stagingWorkerProbe.close(),
        activationApiProbe.close(),
        activationWorkerProbe.close(),
        authoring.close(),
        stagingAuthoring.close(),
        activationAuthoring.close(),
        connections.close(),
        usage.close(),
        activationRunPersistence.close(),
        identity.close(),
      ]);
    }
  });
});
