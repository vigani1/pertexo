import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { calculateDatabaseConnectionBudget } from './validate-database-connection-budget.mjs';
import { validateReadinessHealthCheck } from './validate-readiness-health-check.mjs';
import {
  collectRuntimeWorkspaces,
  expectedCommands,
  validateRuntimeClosure,
} from './validate-runtime-closure.mjs';

const root = resolve(import.meta.dirname, '../..');
const credentialPattern =
  /(DATABASE_.*_URL|REDIS_URL|SECRET.*KEY|CLIENT_SECRET|TRANSACTION_KEY|TOKEN_KEY|ACCESS_KEY_ID|AUTH_MAIL_KEY|AUTH_MAIL_EMAIL_API_KEY|BETTER_AUTH_SECRET)$/u;
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
  [
    'worker',
    {
      ready: '/tmp/pertexo-worker-ready',
      notReady: '/tmp/pertexo-worker-not-ready',
    },
  ],
  ['lifecycle-command', { ready: '/tmp/pertexo-lifecycle-command-ready' }],
]);
const requiredServingConfiguration = new Map([
  [
    'api',
    [
      'CONNECTION_KMS_KEY_REFERENCE',
      'CONNECTION_KMS_REGION',
      'NODE_COMPATIBILITY_COHORT',
      'SERVICE_VERSION',
      'TRUST_PROXY_CIDRS',
    ],
  ],
  [
    'worker',
    [
      'CONNECTION_KMS_KEY_REFERENCE',
      'CONNECTION_KMS_REGION',
      'NODE_COMPATIBILITY_COHORT',
      'OUTBOX_DISPATCH_JOB_NAMES',
      'SERVICE_VERSION',
    ],
  ],
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
const expectedWorkloadCommands = new Map([
  ['api', ['node', 'apps/api/dist/main.js']],
  [
    'worker',
    [
      '/bin/sh',
      '-c',
      'export WORKER_INSTANCE_ID=$HOSTNAME; exec node apps/worker/dist/main.js',
    ],
  ],
  [
    'lifecycle-command',
    [
      '/bin/sh',
      '-c',
      'export LIFECYCLE_COMMAND_LEASE_OWNER=$HOSTNAME; exec node apps/lifecycle-command/dist/main.js',
    ],
  ],
  [
    'retention',
    [
      '/bin/sh',
      '-c',
      'export RETENTION_LEASE_OWNER=$HOSTNAME; exec node apps/retention/dist/main.js',
    ],
  ],
  ['recovery', ['node', 'apps/recovery/dist/main.js']],
  ['operator-command', ['node', 'apps/operator-command/dist/main.js']],
  ['migration', ['node', 'packages/database/dist/migrate.js']],
]);

function sameSortedValues(actual, expected) {
  return (
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

function assertDistinctStringArray(values, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string' || value.length === 0) ||
    new Set(values).size !== values.length
  )
    throw new Error(`${label} must be a distinct nonempty string list`);
}

function assertDisjointInjectionNames(name, workload) {
  assertDistinctStringArray(workload.configuration, `${name} configuration`);
  assertDistinctStringArray(workload.secrets, `${name} secrets`);
  assertDistinctStringArray(
    workload.sharedConfiguration ?? [],
    `${name} shared configuration`,
  );
  assertDistinctStringArray(
    workload.sharedSecrets ?? [],
    `${name} shared secrets`,
  );
  const environmentNames = Object.keys(workload.environment);
  const groups = [
    environmentNames,
    workload.configuration,
    workload.secrets,
    workload.sharedConfiguration ?? [],
    workload.sharedSecrets ?? [],
  ];
  const allNames = groups.flat();
  if (new Set(allNames).size !== allNames.length)
    throw new Error(
      `${name} environment, configuration, and secret names must be disjoint`,
    );
}

function assertAutoscalingCapacity(name, service, workloads) {
  for (const region of ['eu-central-1', 'eu-west-1']) {
    const capacity = service.capacity[region];
    if (
      capacity === undefined ||
      !Number.isSafeInteger(capacity.min) ||
      !Number.isSafeInteger(capacity.max) ||
      capacity.min < 0 ||
      capacity.max < capacity.min
    )
      throw new Error(`${name} has invalid ${region} autoscaling capacity`);
    const desiredCount = workloads[name].desiredCount[region];
    if (!Number.isSafeInteger(desiredCount) || desiredCount < 0)
      throw new Error(`${name} has invalid ${region} desired count`);
    if (desiredCount < capacity.min || desiredCount > capacity.max)
      throw new Error(`${name} has invalid ${region} autoscaling capacity`);
  }
}

function assertAutoscalingCooldowns(name, service) {
  const cooldownsAreOrdered =
    Number.isSafeInteger(service.scaleOutCooldownSeconds) &&
    Number.isSafeInteger(service.scaleInCooldownSeconds) &&
    service.scaleOutCooldownSeconds > 0 &&
    service.scaleInCooldownSeconds > service.scaleOutCooldownSeconds;
  if (!cooldownsAreOrdered)
    throw new Error(`${name} autoscaling cooldowns must favor slower scale-in`);
  if (
    name === 'worker' &&
    (!Number.isSafeInteger(service.configuredSlotsPerTask) ||
      service.configuredSlotsPerTask <= 0)
  )
    throw new Error('worker autoscaling requires configured slot capacity');
}

function assertScalingSignal(name, signal, expectedSignals) {
  if (
    !expectedSignals.has(signal.name) ||
    expectedSignals.get(signal.name) !== signal.metric
  )
    throw new Error(`${name} has an unexpected ${signal.name} scaling metric`);
  const measurementIsValid =
    ['Average', 'Maximum', 'Sum', 'p95'].includes(signal.statistic) &&
    Number.isFinite(signal.threshold) &&
    signal.threshold > 0;
  if (!measurementIsValid)
    throw new Error(`${name} ${signal.name} scaling signal is invalid`);
  const evaluationWindowIsValid =
    Number.isSafeInteger(signal.periodSeconds) &&
    signal.periodSeconds >= 60 &&
    Number.isSafeInteger(signal.evaluationPeriods) &&
    signal.evaluationPeriods >= 1;
  if (!evaluationWindowIsValid)
    throw new Error(`${name} ${signal.name} scaling signal is invalid`);
  if (name !== 'worker' || signal.name !== 'active-slots') return;
  const usesRunningCapacity =
    signal.unit === 'Ratio' &&
    signal.statistic === 'Sum' &&
    signal.normalization ===
      'metric/(runningTaskCount*configuredSlotsPerTask)' &&
    signal.threshold < 1;
  if (!usesRunningCapacity)
    throw new Error(
      'worker active-slot scaling must normalize the summed count by running-task capacity',
    );
}

function assertAutoscalingSignals(name, service, expectedSignals) {
  if (!Array.isArray(service.signals))
    throw new Error(
      `${name} must declare exactly the required scaling signals`,
    );
  const signalNames = service.signals.map((signal) => signal?.name);
  if (
    signalNames.length !== expectedSignals.size ||
    !sameSortedValues(signalNames, expectedSignals.keys())
  )
    throw new Error(
      `${name} must declare exactly the required scaling signals`,
    );
  for (const signal of service.signals)
    assertScalingSignal(name, signal, expectedSignals);
}

async function workspaceManifestDirectories(repositoryRoot, parent) {
  return (
    await readdir(resolve(repositoryRoot, parent), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

export async function loadDeploymentInputs(repositoryRoot = root) {
  const [manifest, autoscaling, databaseConnectionBudget, externalPlatform] =
    await Promise.all(
      [
        'workloads.json',
        'autoscaling.json',
        'database-connection-budget.json',
        'external-platform-contract.json',
      ].map((file) =>
        readFile(
          resolve(repositoryRoot, 'infrastructure/ecs', file),
          'utf8',
        ).then(JSON.parse),
      ),
    );
  const [dockerfile, releaseJob, appDirectories, packageDirectories] =
    await Promise.all([
      readFile(resolve(repositoryRoot, 'Dockerfile'), 'utf8'),
      readFile(
        resolve(repositoryRoot, 'infrastructure/ecs/run-release-job.sh'),
        'utf8',
      ),
      workspaceManifestDirectories(repositoryRoot, 'apps'),
      workspaceManifestDirectories(repositoryRoot, 'packages'),
    ]);
  const workspaceByName = new Map();
  for (const directory of [...appDirectories, ...packageDirectories]) {
    const packageManifest = JSON.parse(
      await readFile(
        resolve(repositoryRoot, directory, 'package.json'),
        'utf8',
      ),
    );
    workspaceByName.set(packageManifest.name, { directory, packageManifest });
  }
  return {
    autoscaling,
    databaseConnectionBudget,
    dockerfile,
    externalPlatform,
    manifest,
    releaseJob,
    runtimeWorkspaces: collectRuntimeWorkspaces(
      expectedCommands,
      workspaceByName,
    ),
  };
}

export function validateDeploymentContracts({
  autoscaling,
  databaseConnectionBudget,
  dockerfile,
  externalPlatform,
  manifest,
  releaseJob,
  runtimeWorkspaces,
}) {
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
    !sameSortedValues(
      Object.keys(externalPlatform.network.egressByWorkload),
      expectedExternalWorkloads,
    ) ||
    !sameSortedValues(
      externalPlatform.network.requiredRegionalEndpoints,
      expectedRegionalEndpoints,
    )
  )
    throw new Error('external platform egress inventory is incomplete');
  if (
    !sameSortedValues(
      externalPlatform.telemetry.requiredWorkloads,
      expectedTelemetryWorkloads,
    ) ||
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
    !sameSortedValues(externalPlatform.recoveryWriterFence.writerWorkloads, [
      'api',
      'worker',
      'lifecycle-command',
      'retention',
      'operator-command',
    ])
  )
    throw new Error(
      'external platform recovery writer inventory is incomplete',
    );

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
  validateRuntimeClosure(dockerfile, runtimeWorkspaces);

  if (
    manifest.schemaVersion !== 1 ||
    !sameSortedValues(
      Object.keys(manifest.workloads),
      expectedExternalWorkloads,
    )
  )
    throw new Error('workload inventory must exactly match runtime roles');
  for (const name of expectedCommands.keys()) {
    const workload = manifest.workloads[name];
    if (!workload) throw new Error(`missing ${name} workload`);
    if (
      !Array.isArray(workload.command) ||
      JSON.stringify(workload.command) !==
        JSON.stringify(expectedWorkloadCommands.get(name))
    )
      throw new Error(`${name} has the wrong command`);
    if (
      typeof workload.environment !== 'object' ||
      workload.environment === null ||
      Array.isArray(workload.environment)
    )
      throw new Error(`${name} has an invalid environment`);
    assertDisjointInjectionNames(name, workload);
    const environmentNames = Object.keys(workload.environment);
    const leaked = environmentNames.filter((key) =>
      credentialPattern.test(key),
    );
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
    if (
      (workload.sharedConfiguration ?? []).some((key) =>
        credentialPattern.test(key),
      )
    )
      throw new Error(
        `${name} exposes a shared credential through configuration parameters`,
      );
    if (
      (workload.sharedSecrets ?? []).some((key) => !credentialPattern.test(key))
    )
      throw new Error(`${name} has a non-credential in shared Secrets Manager`);
    if (workload.kind === 'service' && !workload.healthCheck)
      throw new Error(`${name} service requires a health check`);
    if (workload.kind !== 'service' && workload.healthCheck)
      throw new Error(`${name} job must report health by exit status`);
    const readinessMarker = readinessMarkers.get(name);
    if (readinessMarker !== undefined)
      validateReadinessHealthCheck(name, workload.healthCheck, readinessMarker);
    if (
      telemetryWorkloads.has(name) &&
      !workload.configuration.includes('OTEL_EXPORTER_OTLP_ENDPOINT')
    )
      throw new Error(`${name} must receive the production OTLP endpoint`);
    for (const configuration of requiredServingConfiguration.get(name) ?? []) {
      if (!workload.configuration.includes(configuration))
        throw new Error(`${name} must receive ${configuration} configuration`);
    }
  }

  for (const name of ['api', 'worker']) {
    const workload = manifest.workloads[name];
    if (
      !sameSortedValues(workload.sharedConfiguration ?? [], [
        'AUTH_MAIL_KEY_VERSION',
      ]) ||
      !sameSortedValues(workload.sharedSecrets ?? [], ['AUTH_MAIL_KEY']) ||
      (name === 'api'
        ? workload.environment.AUTH_MAIL_MODE !== 'durable' ||
          workload.environment.SESSION_COOKIE_SECURE !== 'true' ||
          !workload.configuration.includes('AUTH_MAIL_FROM') ||
          !workload.configuration.includes('PUBLIC_WEB_ORIGIN') ||
          !workload.secrets.includes('BETTER_AUTH_SECRET')
        : workload.environment.AUTH_MAIL_DELIVERY_ENABLED !== 'true' ||
          !workload.secrets.includes('AUTH_MAIL_EMAIL_API_KEY'))
    )
      throw new Error(`${name} authentication mail deployment is incomplete`);
  }

  for (const name of ['api', 'worker']) {
    const counts = manifest.workloads[name].desiredCount;
    for (const region of ['eu-central-1', 'eu-west-1']) {
      if (!Number.isSafeInteger(counts?.[region]) || counts[region] < 0)
        throw new Error(`${name} has invalid ${region} desired count`);
    }
    if (counts['eu-central-1'] < 2 || counts['eu-west-1'] !== 0)
      throw new Error(`${name} does not match ADR 015 regional desired counts`);
  }

  if (autoscaling.schemaVersion !== 1)
    throw new Error('unsupported autoscaling schema version');
  if (!sameSortedValues(Object.keys(autoscaling.services), ['api', 'worker']))
    throw new Error(
      'autoscaling must contain only independent api and worker services',
    );
  for (const [name, expectedSignals] of expectedScalingSignals) {
    const service = autoscaling.services[name];
    if (!service || service.workload !== name)
      throw new Error(`${name} autoscaling must target its own workload`);
    assertAutoscalingCapacity(name, service, manifest.workloads);
    assertAutoscalingCooldowns(name, service);
    assertAutoscalingSignals(name, service, expectedSignals);
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
    externalPlatform,
  );
}

async function main() {
  validateDeploymentContracts(await loadDeploymentInputs());
  process.stdout.write('ECS deployment contract is valid.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
