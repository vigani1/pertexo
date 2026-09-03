import { randomUUID } from 'node:crypto';

import {
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import {
  composeExecutableCompatibilityRelease,
  describeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';

type ReleaseInput = Parameters<typeof composeExecutableCompatibilityRelease>[0];
type CurrentReleaseRow = Readonly<{
  catalog_json: unknown;
  epoch: number;
  fingerprint: string;
}>;

export async function activateCompatibilityReleaseFixture(options: {
  actorId: string;
  apiUrl: string;
  artifactPrefix: string;
  migrationUrl: string;
  reasons: Readonly<{ activate: string; approve: string; prepare: string }>;
  readCurrent: () => Promise<CurrentReleaseRow | undefined>;
  targetRelease: ReleaseInput;
  workerUrl: string;
}): Promise<void> {
  const target = describeExecutableCompatibilityRelease(
    composeExecutableCompatibilityRelease(options.targetRelease),
  );
  const current = await options.readCurrent();
  if (current === undefined) throw new Error('compatibility pointer missing');
  const predecessor = {
    catalogJson:
      typeof current.catalog_json === 'string'
        ? current.catalog_json
        : JSON.stringify(current.catalog_json),
    epoch: current.epoch,
    fingerprint: current.fingerprint,
  };
  const supported = [predecessor, target];
  const maintenance = createCompatibilityReleaseMaintenance(
    parseDatabaseConfig({
      connectionString: options.migrationUrl,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    }),
  );
  const apiProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: options.apiUrl, max: 1 }),
    supported,
  );
  const workerProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: options.workerUrl, max: 1 }),
    supported,
  );
  const epoch = String(target.epoch);
  const deploymentId = `${options.artifactPrefix}-${epoch}-${randomUUID()}`;
  const approvalId = randomUUID();
  try {
    await maintenance.prepare({
      actorId: options.actorId,
      actorKind: 'deployment',
      expectedPredecessor: predecessor,
      reason: options.reasons.prepare,
      target,
    });
    await Promise.all([
      apiProbe.checkTarget(target),
      workerProbe.checkTarget(target),
    ]);
    for (const roleKind of ['api', 'worker'] as const)
      await maintenance.recordPreactivation({
        artifactId: `${options.artifactPrefix}-${roleKind}-${epoch}`,
        checkId: randomUUID(),
        deploymentId,
        roleKind,
        target,
      });
    await maintenance.approve({
      actorId: options.actorId,
      approvalId,
      deploymentId,
      reason: options.reasons.approve,
      requiredApiArtifacts: [`${options.artifactPrefix}-api-${epoch}`],
      requiredWorkerArtifacts: [`${options.artifactPrefix}-worker-${epoch}`],
      target,
    });
    await maintenance.activate({
      activationId: randomUUID(),
      actorId: options.actorId,
      actorKind: 'deployment',
      approvalId,
      expectedPredecessor: predecessor,
      reason: options.reasons.activate,
    });
  } finally {
    await Promise.allSettled([
      maintenance.close(),
      apiProbe.close(),
      workerProbe.close(),
    ]);
  }
}
