/* global process */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(
  await readFile(resolve(root, 'infrastructure/ecs/workloads.json'), 'utf8'),
);
const autoscaling = JSON.parse(
  await readFile(resolve(root, 'infrastructure/ecs/autoscaling.json'), 'utf8'),
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

if (!dockerfile.includes('USER 10001:10001'))
  throw new Error('runtime image must be non-root');
if (
  (dockerfile.match(/^FROM node:[^\s]+@sha256:[a-f0-9]{64}/gmu) ?? [])
    .length !== 3
)
  throw new Error('every Node image stage must pin an immutable base digest');
if (!dockerfile.includes('ENTRYPOINT ["/usr/bin/tini", "--"]'))
  throw new Error('runtime image must use tini');
if (!dockerfile.includes('pnpm install --prod --frozen-lockfile'))
  throw new Error('runtime image must contain production dependencies only');

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
process.stdout.write('ECS deployment contract is valid.\n');
