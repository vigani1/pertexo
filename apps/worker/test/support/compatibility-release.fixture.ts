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

export type CompatibilityReleaseFixtureFactories = Readonly<{
  maintenance: typeof createCompatibilityReleaseMaintenance;
  readinessProbe: typeof createCompatibilityReleaseReadinessProbe;
}>;

const productionFactories: CompatibilityReleaseFixtureFactories = {
  maintenance: createCompatibilityReleaseMaintenance,
  readinessProbe: createCompatibilityReleaseReadinessProbe,
};

export async function activateCompatibilityReleaseFixture(options: {
  actorId: string;
  apiUrl: string;
  artifactPrefix: string;
  migrationUrl: string;
  reasons: Readonly<{ activate: string; approve: string; prepare: string }>;
  readCurrent: () => Promise<CurrentReleaseRow | undefined>;
  targetRelease: ReleaseInput;
  workerUrl: string;
  factories?: CompatibilityReleaseFixtureFactories;
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
  const factories = options.factories ?? productionFactories;
  const epoch = String(target.epoch);
  const deploymentId = `${options.artifactPrefix}-${epoch}-${randomUUID()}`;
  const approvalId = randomUUID();
  let maintenance:
    ReturnType<typeof createCompatibilityReleaseMaintenance> | undefined;
  let apiProbe:
    ReturnType<typeof createCompatibilityReleaseReadinessProbe> | undefined;
  let workerProbe:
    ReturnType<typeof createCompatibilityReleaseReadinessProbe> | undefined;
  let primaryFailure: unknown;
  let failed = false;
  try {
    maintenance = factories.maintenance(
      parseDatabaseConfig({
        connectionString: options.migrationUrl,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    apiProbe = factories.readinessProbe(
      parseDatabaseConfig({ connectionString: options.apiUrl, max: 1 }),
      supported,
    );
    workerProbe = factories.readinessProbe(
      parseDatabaseConfig({ connectionString: options.workerUrl, max: 1 }),
      supported,
    );
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
  } catch (error: unknown) {
    failed = true;
    primaryFailure = error;
  }
  const cleanupResults = await Promise.allSettled([
    Promise.resolve().then(() => maintenance?.close()),
    Promise.resolve().then(() => apiProbe?.close()),
    Promise.resolve().then(() => workerProbe?.close()),
  ]);
  const cleanupFailures = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failed && cleanupFailures.length > 0)
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      'Compatibility release fixture and cleanup failed',
    );
  if (failed) {
    // Preserve legacy non-Error rejection values from test infrastructure.
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(
      cleanupFailures,
      'Compatibility release fixture cleanup failed',
    );
}
