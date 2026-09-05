/* global process */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { calculateDatabaseConnectionBudget } from './validate-database-connection-budget.mjs';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(
  await readFile(resolve(root, 'infrastructure/ecs/workloads.json'), 'utf8'),
);
const autoscaling = JSON.parse(
  await readFile(resolve(root, 'infrastructure/ecs/autoscaling.json'), 'utf8'),
);
const databaseConnectionBudget = JSON.parse(
  await readFile(
    resolve(root, 'infrastructure/ecs/database-connection-budget.json'),
    'utf8',
  ),
);
const externalPlatform = JSON.parse(
  await readFile(
    resolve(root, 'infrastructure/ecs/external-platform-contract.json'),
    'utf8',
  ),
);
const dockerfile = await readFile(resolve(root, 'Dockerfile'), 'utf8');
const releaseJob = await readFile(
  resolve(root, 'infrastructure/ecs/run-release-job.sh'),
  'utf8',
);
const expectedCommands = new Map([
  ['api', 'apps/api/dist/main.js'],
  ['worker', 'apps/worker/dist/main.js'],
  ['lifecycle-command', 'apps/lifecycle-command/dist/main.js'],
  ['retention', 'apps/retention/dist/main.js'],
  ['recovery', 'apps/recovery/dist/main.js'],
  ['operator-command', 'apps/operator-command/dist/main.js'],
  ['migration', 'packages/database/dist/migrate.js'],
]);
const credentialPattern =
  /(DATABASE_.*_URL|REDIS_URL|SECRET.*KEY|CLIENT_SECRET|TRANSACTION_KEY|ACCESS_KEY_ID)$/u;
const telemetryWorkloads = new Set([
  'api',
  'worker',
  'lifecycle-command',
  'retention',
  'recovery',
  'operator-command',
]);
const expectedScalingSignals = new Map([
  [
    'api',
    new Map([
      ['latency', 'pertexo.api.request.duration'],
      ['saturation', 'AWS/ECS.CPUUtilization'],
    ]),
  ],
  [
    'worker',
    new Map([
      ['active-slots', 'pertexo.transport.handler.active'],
      ['oldest-admitted-job', 'pertexo.transport.queue.oldest_job_age'],
    ]),
  ],
]);
const readinessMarkers = new Map([
  ['worker', '/tmp/pertexo-worker-ready'],
  ['lifecycle-command', '/tmp/pertexo-lifecycle-command-ready'],
]);
const expectedExternalWorkloads = [...expectedCommands.keys()];
const expectedTelemetryWorkloads = [...telemetryWorkloads];
const expectedRegionalEndpoints = [
  'container-registry',
  'identity-provider',
  'kms',
  'logs',
  'object-storage',
  'otel',
  'postgresql',
  'provider-api',
  'redis',
  'secrets-manager',
];

async function workspaceManifestDirectories(parent) {
  return (await readdir(resolve(root, parent), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

const workspaceDirectories = [
  ...(await workspaceManifestDirectories('apps')),
  ...(await workspaceManifestDirectories('packages')),
];
const workspaceByName = new Map();
for (const directory of workspaceDirectories) {
  const packageManifest = JSON.parse(
    await readFile(resolve(root, directory, 'package.json'), 'utf8'),
  );
  workspaceByName.set(packageManifest.name, { directory, packageManifest });
}

const runtimeRoots = [
  ...Object.keys(expectedCommands)
    .filter((name) => name !== 'migration')
    .map((name) => workspaceByName.get(`@pertexo/${name}`)),
  workspaceByName.get('@pertexo/database'),
];
const runtimeWorkspaces = new Map();
const pendingRuntimeWorkspaces = runtimeRoots.filter(Boolean);
while (pendingRuntimeWorkspaces.length > 0) {
  const workspace = pendingRuntimeWorkspaces.pop();
  if (runtimeWorkspaces.has(workspace.packageManifest.name)) continue;
  runtimeWorkspaces.set(workspace.packageManifest.name, workspace);
  for (const dependencyName of Object.keys(
    workspace.packageManifest.dependencies ?? {},
  )) {
    const dependency = workspaceByName.get(dependencyName);
    if (dependency !== undefined) pendingRuntimeWorkspaces.push(dependency);
  }
}

if (
  externalPlatform.schemaVersion !== 1 ||
  externalPlatform.provider !== 'aws' ||
  externalPlatform.computePlatform !== 'ecs-fargate'
)
  throw new Error('unsupported external platform contract');
if (
  externalPlatform.primaryRegion !== 'eu-central-1' ||
  externalPlatform.recoveryRegion !== 'eu-west-1'
)
  throw new Error('external platform regions must match ADR 015');
if (
  externalPlatform.evidence.source !== 'aws-api' ||
  !externalPlatform.evidence.requireDistinctTaskRoles ||
  !externalPlatform.evidence.requireDistinctExecutionRoles ||
  !externalPlatform.evidence.forbidWildcardIamActions ||
  !externalPlatform.evidence.forbidSensitiveResourceWildcards
)
  throw new Error('external platform IAM evidence must fail closed');
if (
  externalPlatform.network.assignPublicIp ||
  externalPlatform.network.minimumPrimaryAvailabilityZones < 2 ||
  externalPlatform.network.publicIngress.workload !== 'api' ||
  externalPlatform.network.publicIngress.containerPort !== 3000 ||
  externalPlatform.network.publicIngress.sourceClass !== 'trusted-ingress'
)
  throw new Error('external platform network contract is unsafe');
if (
  JSON.stringify(
    Object.keys(externalPlatform.network.egressByWorkload).sort(),
  ) !== JSON.stringify(expectedExternalWorkloads.sort()) ||
  JSON.stringify(
    [...externalPlatform.network.requiredRegionalEndpoints].sort(),
  ) !== JSON.stringify(expectedRegionalEndpoints)
)
  throw new Error('external platform egress inventory is incomplete');
if (
  JSON.stringify([...externalPlatform.telemetry.requiredWorkloads].sort()) !==
    JSON.stringify(expectedTelemetryWorkloads.sort()) ||
  !externalPlatform.telemetry.requireMetricPublication ||
  !externalPlatform.telemetry.requireAlarmActions
)
  throw new Error('external platform telemetry contract is incomplete');
if (
  externalPlatform.migration.workload !== 'migration' ||
  externalPlatform.migration.maximumConcurrentTasks !== 1 ||
  !externalPlatform.migration.mustCompleteBeforeServiceUpdate
)
  throw new Error('external platform migration contract is unsafe');
if (
  externalPlatform.recoveryWriterFence.region !== 'eu-west-1' ||
  !externalPlatform.recoveryWriterFence.requiredClosedIngress ||
  externalPlatform.recoveryWriterFence.requiredWriterDesiredCount !== 0
)
  throw new Error('external platform recovery writer fence is unsafe');
if (
  JSON.stringify(
    [...externalPlatform.recoveryWriterFence.writerWorkloads].sort(),
  ) !==
  JSON.stringify(
    [
      'api',
      'worker',
      'lifecycle-command',
      'retention',
      'operator-command',
    ].sort(),
  )
)
  throw new Error('external platform recovery writer inventory is incomplete');

if (!dockerfile.includes('USER 10001:10001'))
  throw new Error('runtime image must be non-root');
if (
  (dockerfile.match(/^FROM node:[^\s]+@sha256:[a-f0-9]{64}/gmu) ?? [])
    .length !== 3
)
  throw new Error('every Node image stage must pin an immutable base digest');
if (/apt-get\s+(?:update|upgrade|install)/u.test(dockerfile))
  throw new Error('runtime image must not resolve mutable OS packages');
if (!dockerfile.includes('pnpm install --prod --frozen-lockfile'))
  throw new Error('runtime image must contain production dependencies only');
for (const { directory, packageManifest } of runtimeWorkspaces.values()) {
  if (packageManifest.scripts?.build === undefined) continue;
  const expectedCopy = `/workspace/${directory}/dist ./${directory}/dist`;
  if (!dockerfile.includes(expectedCopy))
    throw new Error(
      `runtime image is missing built workspace dependency ${packageManifest.name}`,
    );
}

for (const [name, expectedEntry] of expectedCommands) {
  const workload = manifest.workloads[name];
  if (!workload) throw new Error(`missing ${name} workload`);
  if (!workload.command.join(' ').includes(expectedEntry))
    throw new Error(`${name} has the wrong command`);
  const environmentNames = Object.keys(workload.environment);
  const leaked = environmentNames.filter((key) => credentialPattern.test(key));
  if (leaked.length > 0)
    throw new Error(
      `${name} exposes credentials in environment: ${leaked.join(', ')}`,
    );
  if (workload.configuration.some((key) => credentialPattern.test(key)))
    throw new Error(
      `${name} exposes a credential through configuration parameters`,
    );
  if (workload.secrets.some((key) => !credentialPattern.test(key)))
    throw new Error(`${name} has a non-credential in Secrets Manager`);
  if (workload.kind === 'service' && !workload.healthCheck)
    throw new Error(`${name} service requires a health check`);
  if (workload.kind !== 'service' && workload.healthCheck)
    throw new Error(`${name} job must report health by exit status`);
  const readinessMarker = readinessMarkers.get(name);
  if (
    readinessMarker !== undefined &&
    !workload.healthCheck.join(' ').includes(readinessMarker)
  )
    throw new Error(`${name} health check must require its readiness marker`);
  if (
    telemetryWorkloads.has(name) &&
    !workload.configuration.includes('OTEL_EXPORTER_OTLP_ENDPOINT')
  )
    throw new Error(`${name} must receive the production OTLP endpoint`);
}

for (const name of ['api', 'worker']) {
  const counts = manifest.workloads[name].desiredCount;
  if (counts['eu-central-1'] < 2 || counts['eu-west-1'] !== 0) {
    throw new Error(`${name} does not match ADR 015 regional desired counts`);
  }
}

if (autoscaling.schemaVersion !== 1)
  throw new Error('unsupported autoscaling schema version');
const scalingNames = Object.keys(autoscaling.services).sort();
if (scalingNames.join(',') !== 'api,worker')
  throw new Error(
    'autoscaling must contain only independent api and worker services',
  );
for (const [name, expectedSignals] of expectedScalingSignals) {
  const service = autoscaling.services[name];
  if (!service || service.workload !== name)
    throw new Error(`${name} autoscaling must target its own workload`);
  for (const region of ['eu-central-1', 'eu-west-1']) {
    const capacity = service.capacity[region];
    if (
      !capacity ||
      !Number.isSafeInteger(capacity.min) ||
      !Number.isSafeInteger(capacity.max) ||
      capacity.min < 0 ||
      capacity.max < capacity.min ||
      manifest.workloads[name].desiredCount[region] < capacity.min ||
      manifest.workloads[name].desiredCount[region] > capacity.max
    ) {
      throw new Error(`${name} has invalid ${region} autoscaling capacity`);
    }
  }
  if (
    !Number.isSafeInteger(service.scaleOutCooldownSeconds) ||
    !Number.isSafeInteger(service.scaleInCooldownSeconds) ||
    service.scaleOutCooldownSeconds <= 0 ||
    service.scaleInCooldownSeconds <= service.scaleOutCooldownSeconds
  ) {
    throw new Error(`${name} autoscaling cooldowns must favor slower scale-in`);
  }
  if (
    name === 'worker' &&
    (!Number.isSafeInteger(service.configuredSlotsPerTask) ||
      service.configuredSlotsPerTask <= 0)
  ) {
    throw new Error('worker autoscaling requires configured slot capacity');
  }
  if (service.signals.length !== expectedSignals.size)
    throw new Error(
      `${name} must declare exactly the required scaling signals`,
    );
  for (const signal of service.signals) {
    if (
      !expectedSignals.has(signal.name) ||
      expectedSignals.get(signal.name) !== signal.metric
    )
      throw new Error(
        `${name} has an unexpected ${signal.name} scaling metric`,
      );
    if (
      !['Average', 'Maximum', 'Sum', 'p95'].includes(signal.statistic) ||
      !Number.isFinite(signal.threshold) ||
      signal.threshold <= 0 ||
      !Number.isSafeInteger(signal.periodSeconds) ||
      signal.periodSeconds < 60 ||
      !Number.isSafeInteger(signal.evaluationPeriods) ||
      signal.evaluationPeriods < 1
    ) {
      throw new Error(`${name} ${signal.name} scaling signal is invalid`);
    }
    if (
      name === 'worker' &&
      signal.name === 'active-slots' &&
      (signal.unit !== 'Ratio' ||
        signal.statistic !== 'Sum' ||
        signal.normalization !==
          'metric/(runningTaskCount*configuredSlotsPerTask)' ||
        signal.threshold <= 0 ||
        signal.threshold >= 1)
    ) {
      throw new Error(
        'worker active-slot scaling must normalize the summed count by running-task capacity',
      );
    }
  }
}
if (manifest.workloads.migration.kind !== 'release-job')
  throw new Error('migrations must be a release job');
if (
  !releaseJob.includes('aws ecs wait tasks-stopped') ||
  !releaseJob.includes('exitCode')
)
  throw new Error(
    'release job must wait for and verify migration task success',
  );
calculateDatabaseConnectionBudget(
  databaseConnectionBudget,
  manifest,
  autoscaling,
);
process.stdout.write('ECS deployment contract is valid.\n');
