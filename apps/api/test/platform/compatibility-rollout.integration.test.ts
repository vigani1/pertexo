import { randomUUID } from 'node:crypto';

import {
  CompatibilityReleaseMismatchError,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  parseDatabaseConfig,
} from '@pertexo/database';
import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';

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
    const targetNodeRelease = createRegistryReleaseSuccessor({
      previous: CORE_REGISTRY_RELEASE,
      epoch: CORE_REGISTRY_RELEASE.epoch + 1,
      definitions: CORE_REGISTRY_RELEASE.definitions.map((manifest) => ({
        ...manifest,
        lifecycle:
          manifest.definition.key === 'core.manual'
            ? ('deprecated' as const)
            : manifest.lifecycle,
      })),
      executors: CORE_REGISTRY_RELEASE.executors,
      policies: CORE_REGISTRY_RELEASE.policies,
    });
    const current = composeExecutableCompatibilityRelease(
      CORE_REGISTRY_RELEASE,
    );
    const target = composeExecutableCompatibilityRelease(targetNodeRelease);
    const support = createExecutableCompatibilityReleaseSupport([
      current,
      target,
    ]);
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
    } finally {
      await Promise.all([
        maintenance.close(),
        apiProbe.close(),
        workerProbe.close(),
        oldApiProbe.close(),
      ]);
    }
  });
});
