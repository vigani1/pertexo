import { randomUUID } from 'node:crypto';

import {
  CompatibilityReleaseMismatchError,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  createIdentityWorkspaceDatabase,
  parseDatabaseConfig,
  WorkflowDefinitionPlacementError,
} from '@pertexo/database';
import { CORE_REGISTRY_RELEASE_SUPPORT } from '@pertexo/nodes-core';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/graph';
import { describe, expect, it } from 'vitest';

import { createCoreWorkflowAuthoringDatabase } from '../../src/platform/workflow/workflow-runtime.module.js';

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const apiUrl = process.env.DATABASE_API_URL;
const workerUrl = process.env.DATABASE_WORKER_URL;
const enabled =
  process.env.API_COMPATIBILITY_ROLLOUT_INTEGRATION === 'true' &&
  migrationUrl !== undefined &&
  apiUrl !== undefined &&
  workerUrl !== undefined;

const databaseConfig = (connectionString: string) =>
  parseDatabaseConfig({
    connectionString,
    max: 1,
    ownerRole: process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner',
    workerRuntimeRole:
      process.env.POSTGRES_WORKER_RUNTIME_USER ?? 'pertexo_worker',
  });

describe.runIf(enabled)('additive compatibility release rollout', () => {
  it('preactivates the complete API/worker cohort before atomically activating the target', async () => {
    const support = createExecutableCompatibilityReleaseSupport(
      CORE_REGISTRY_RELEASE_SUPPORT.map(composeExecutableCompatibilityRelease),
    );
    const [currentDescription, targetDescription] = support.descriptions;
    if (currentDescription === undefined || targetDescription === undefined)
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
    const identity = createIdentityWorkspaceDatabase(
      databaseConfig(apiUrl ?? ''),
    );
    const authoring = createCoreWorkflowAuthoringDatabase(
      databaseConfig(apiUrl ?? ''),
    );
    const deploymentId = `phase3-rollout-${randomUUID()}`;
    const approvalId = randomUUID();
    try {
      await maintenance.prepare({
        actorId: 'phase3-rollout-integration',
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
        actorId: 'phase3-rollout-integration',
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
        actorId: 'phase3-rollout-integration',
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
    } finally {
      await Promise.all([
        maintenance.close(),
        apiProbe.close(),
        workerProbe.close(),
        oldApiProbe.close(),
        authoring.close(),
        identity.close(),
      ]);
    }
  });
});
