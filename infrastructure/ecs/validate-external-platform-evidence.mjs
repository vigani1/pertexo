/* global process */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameMembers(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function isArn(value, service) {
  return (
    typeof value === 'string' &&
    new RegExp(`^arn:aws[a-z-]*:${service}:`, 'u').test(value)
  );
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function assertUnique(values, description) {
  assert(
    new Set(values).size === values.length,
    `${description} must be distinct by workload`,
  );
}

function assertSource(resource, description) {
  assert(
    resource?.source === 'aws-api',
    `${description} must come from aws-api`,
  );
}

function assertRole(role, description, contract) {
  assertSource(role, description);
  assert(isArn(role.arn, 'iam'), `${description} must have an IAM ARN`);
  assert(isSha256(role.policySha256), `${description} must hash its policy`);
  assert(
    !contract.evidence.forbidWildcardIamActions ||
      role.hasWildcardAction === false,
    `${description} must not contain wildcard actions`,
  );
  assert(
    !contract.evidence.forbidSensitiveResourceWildcards ||
      role.hasSensitiveWildcardResource === false,
    `${description} must not contain wildcard sensitive resources`,
  );
}

function assertNetwork(regionEvidence, region, contract) {
  const network = regionEvidence.network;
  assertSource(network, `${region} network`);
  assert(
    network.assignPublicIp === contract.network.assignPublicIp,
    `${region} tasks must not receive public IPs`,
  );
  assert(
    sameMembers(
      network.reachableRegionalEndpoints,
      contract.network.requiredRegionalEndpoints,
    ),
    `${region} regional endpoint reachability drifted`,
  );
  assert(
    sameMembers(
      Object.keys(network.egressByWorkload),
      Object.keys(contract.network.egressByWorkload),
    ) &&
      Object.entries(contract.network.egressByWorkload).every(
        ([name, expected]) =>
          sameMembers(network.egressByWorkload[name], expected),
      ),
    `${region} workload egress policy drifted`,
  );
  assert(
    Array.isArray(network.securityGroupIds) &&
      network.securityGroupIds.length > 0 &&
      network.securityGroupIds.every((id) => /^sg-[a-f0-9]+$/u.test(id)),
    `${region} must report concrete security groups`,
  );
  assert(
    Array.isArray(network.subnetIds) &&
      network.subnetIds.length > 0 &&
      network.subnetIds.every((id) => /^subnet-[a-f0-9]+$/u.test(id)),
    `${region} must report concrete subnets`,
  );
  assert(
    isSha256(network.routeAndSecurityGroupPolicySha256),
    `${region} must hash normalized route and security-group policy`,
  );
  if (region === contract.primaryRegion) {
    assert(
      new Set(network.availabilityZones).size >=
        contract.network.minimumPrimaryAvailabilityZones,
      `${region} must span the required availability zones`,
    );
    assert(
      network.publicIngress.length === 1 &&
        network.publicIngress[0].workload ===
          contract.network.publicIngress.workload &&
        network.publicIngress[0].containerPort ===
          contract.network.publicIngress.containerPort &&
        network.publicIngress[0].sourceClass ===
          contract.network.publicIngress.sourceClass &&
        Array.isArray(network.publicIngress[0].sourceSecurityGroupIds) &&
        network.publicIngress[0].sourceSecurityGroupIds.length > 0 &&
        network.publicIngress[0].sourceSecurityGroupIds.every((id) =>
          /^sg-[a-f0-9]+$/u.test(id),
        ),
      `${region} public ingress must be limited to the trusted API ingress`,
    );
  } else {
    assert(
      network.publicIngress.length === 0,
      `${region} recovery ingress must remain closed`,
    );
  }
}

function assertSecretEvidence(workloadEvidence, workload, name) {
  const actualNames = workloadEvidence.secretReferences.map(
    (secret) => secret.name,
  );
  assert(
    sameMembers(actualNames, workload.secrets),
    `${name} secret references drifted from workloads.json`,
  );
  for (const secret of workloadEvidence.secretReferences) {
    assertSource(secret, `${name} secret ${secret.name}`);
    assert(
      isArn(secret.arn, 'secretsmanager'),
      `${name} secret ${secret.name} must have a Secrets Manager ARN`,
    );
    assert(
      isArn(secret.kmsKeyArn, 'kms'),
      `${name} secret ${secret.name} must identify its KMS key`,
    );
    assert(
      secret.executionRoleCanDecrypt === true,
      `${name} secret ${secret.name} must prove execution-role KMS permission`,
    );
    assert(
      secret.executionRoleCanRead === true,
      `${name} secret ${secret.name} must prove execution-role read permission`,
    );
  }
}

function assertService(workloadEvidence, workload, name, region, contract) {
  const service = workloadEvidence.service;
  assertSource(service, `${region} ${name} service`);
  assert(
    service.desiredCount === workload.desiredCount[region],
    `${region} ${name} desired count drifted`,
  );
  assert(
    service.minimumHealthyPercent === contract.services.minimumHealthyPercent &&
      service.maximumPercent === contract.services.maximumPercent &&
      service.healthCheckGracePeriodSeconds ===
        contract.services.healthCheckGracePeriodSeconds &&
      service.drainSeconds === contract.services.drainSeconds,
    `${region} ${name} rollout or drain policy drifted`,
  );
  assert(
    service.deploymentStatus === 'COMPLETED' &&
      service.runningCount === service.desiredCount &&
      service.pendingCount === 0,
    `${region} ${name} deployment is not healthy`,
  );
}

function assertTelemetry(workloadEvidence, name, contract) {
  if (!contract.telemetry.requiredWorkloads.includes(name)) return;
  const telemetry = workloadEvidence.telemetry;
  assertSource(telemetry, `${name} telemetry`);
  assert(
    !contract.telemetry.requireMetricPublication ||
      (Array.isArray(telemetry.publishedMetricNames) &&
        telemetry.publishedMetricNames.length > 0),
    `${name} must prove metric publication`,
  );
  assert(
    !contract.telemetry.requireAlarmActions ||
      (Array.isArray(telemetry.alarmArns) &&
        telemetry.alarmArns.length > 0 &&
        telemetry.alarmArns.every((arn) => isArn(arn, 'cloudwatch')) &&
        telemetry.alarmActionsEnabled === true),
    `${name} must prove enabled alarm wiring`,
  );
}

function assertAutoscaling(regionEvidence, region, autoscaling) {
  for (const [name, expected] of Object.entries(autoscaling.services)) {
    const actual = regionEvidence.autoscaling[name];
    assertSource(actual, `${region} ${name} autoscaling`);
    assert(
      actual.resourceId === `service/pertexo/${name}` &&
        actual.minCapacity === expected.capacity[region].min &&
        actual.maxCapacity === expected.capacity[region].max,
      `${region} ${name} scaling target drifted`,
    );
    assert(
      sameMembers(
        actual.policies.map((policy) => policy.signal),
        expected.signals.map((signal) => signal.name),
      ) &&
        actual.policies.every(
          (policy) =>
            isArn(policy.alarmArn, 'cloudwatch') && policy.enabled === true,
        ),
      `${region} ${name} scaling policy wiring drifted`,
    );
  }
}

function assertMigration(evidence, contract) {
  const migration = evidence.migration;
  assertSource(migration, 'migration execution');
  assert(
    migration.workload === contract.migration.workload &&
      migration.exitCode === 0 &&
      migration.maximumObservedConcurrentTasks <=
        contract.migration.maximumConcurrentTasks,
    'migration execution was unsuccessful or non-exclusive',
  );
  assert(
    !contract.migration.mustCompleteBeforeServiceUpdate ||
      Date.parse(migration.stoppedAt) <=
        Date.parse(migration.servicesUpdatedAt),
    'serving services were updated before migration completed',
  );
  assert(
    isArn(migration.taskArn, 'ecs') &&
      isArn(migration.taskDefinitionArn, 'ecs'),
    'migration must identify its exact ECS task and task definition',
  );
}

function assertRecoveryWriterFence(evidence, contract) {
  const fence = evidence.recoveryWriterFence;
  assertSource(fence, 'recovery writer fence');
  assert(
    fence.region === contract.recoveryWriterFence.region &&
      fence.ingressClosed ===
        contract.recoveryWriterFence.requiredClosedIngress,
    'recovery writer ingress fence is not closed',
  );
  assert(
    sameMembers(
      Object.keys(fence.writerDesiredCounts),
      contract.recoveryWriterFence.writerWorkloads,
    ) &&
      Object.values(fence.writerDesiredCounts).every(
        (count) =>
          count === contract.recoveryWriterFence.requiredWriterDesiredCount,
      ),
    'recovery writer desired-count fence is not closed',
  );
  assert(
    isSha256(fence.routeAndQueuePolicySha256),
    'recovery writer fence must hash route and queue policy state',
  );
}

export async function loadDeploymentContract() {
  const contractBytes = await readFile(
    resolve(root, 'infrastructure/ecs/external-platform-contract.json'),
  );
  return {
    bytes: contractBytes,
    contract: JSON.parse(contractBytes.toString('utf8')),
  };
}

export async function validateExternalPlatformEvidence(
  evidence,
  { now = new Date() } = {},
) {
  const [{ bytes, contract }, workloads, autoscaling] = await Promise.all([
    loadDeploymentContract(),
    readFile(resolve(root, 'infrastructure/ecs/workloads.json'), 'utf8').then(
      JSON.parse,
    ),
    readFile(resolve(root, 'infrastructure/ecs/autoscaling.json'), 'utf8').then(
      JSON.parse,
    ),
  ]);
  assert(contract.schemaVersion === 1, 'unsupported platform contract version');
  assert(evidence.schemaVersion === 1, 'unsupported evidence schema version');
  assert(
    evidence.source === contract.evidence.source,
    'deployment evidence must be collected from AWS APIs',
  );
  assert(
    evidence.contractSha256 ===
      createHash('sha256').update(bytes).digest('hex'),
    'deployment evidence does not match the reviewed platform contract',
  );
  assert(
    /^[a-f0-9]{40}$/u.test(evidence.release?.commitSha),
    'deployment evidence must identify an exact Git commit',
  );
  assert(
    !contract.evidence.requireImmutableImage ||
      /^[^\s]+@sha256:[a-f0-9]{64}$/u.test(evidence.release?.imageUri),
    'deployment evidence must identify a digest-qualified image',
  );
  const observedAt = Date.parse(evidence.observedAt);
  assert(Number.isFinite(observedAt), 'deployment evidence time is invalid');
  assert(
    now.getTime() - observedAt >= 0 &&
      now.getTime() - observedAt <=
        contract.evidence.maximumAgeMinutes * 60_000,
    'deployment evidence is stale or from the future',
  );

  for (const region of [contract.primaryRegion, contract.recoveryRegion]) {
    const regionEvidence = evidence.regions?.[region];
    assert(regionEvidence, `missing ${region} deployment evidence`);
    assertNetwork(regionEvidence, region, contract);
    assert(
      sameMembers(
        Object.keys(regionEvidence.workloads),
        Object.keys(workloads.workloads),
      ),
      `${region} workload inventory drifted`,
    );
    const taskRoles = [];
    const executionRoles = [];
    for (const [name, workload] of Object.entries(workloads.workloads)) {
      const actual = regionEvidence.workloads?.[name];
      assert(actual, `missing ${region} ${name} workload evidence`);
      assertSource(actual, `${region} ${name} workload`);
      assert(
        isArn(actual.taskDefinitionArn, 'ecs'),
        `${region} ${name} must identify its task definition`,
      );
      assert(
        actual.imageUri === evidence.release.imageUri,
        `${region} ${name} image drifted from the release`,
      );
      assertRole(actual.taskRole, `${region} ${name} task role`, contract);
      assertRole(
        actual.executionRole,
        `${region} ${name} execution role`,
        contract,
      );
      taskRoles.push(actual.taskRole.arn);
      executionRoles.push(actual.executionRole.arn);
      assertSecretEvidence(actual, workload, `${region} ${name}`);
      if (workload.kind === 'service')
        assertService(actual, workload, name, region, contract);
      assertTelemetry(actual, name, contract);
    }
    if (contract.evidence.requireDistinctTaskRoles)
      assertUnique(taskRoles, `${region} task roles`);
    if (contract.evidence.requireDistinctExecutionRoles)
      assertUnique(executionRoles, `${region} execution roles`);
    assert(
      sameMembers(
        Object.keys(regionEvidence.autoscaling),
        Object.keys(autoscaling.services),
      ),
      `${region} autoscaling inventory drifted`,
    );
    assertAutoscaling(regionEvidence, region, autoscaling);
  }
  assertMigration(evidence, contract);
  assertRecoveryWriterFence(evidence, contract);
}

async function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) {
    throw new Error(
      'usage: node infrastructure/ecs/validate-external-platform-evidence.mjs <aws-evidence.json>',
    );
  }
  const evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8'));
  await validateExternalPlatformEvidence(evidence);
  process.stdout.write(
    'External AWS platform evidence matches the reviewed deployment contract.\n',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
