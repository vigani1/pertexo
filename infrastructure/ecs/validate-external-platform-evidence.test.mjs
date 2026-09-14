import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadDeploymentContracts,
  validateExternalPlatformEvidence,
} from './validate-external-platform-evidence.mjs';

const now = new Date('2026-08-30T12:00:00.000Z');

async function loadSources() {
  return loadDeploymentContracts();
}

function arn(service, region, resource) {
  return `arn:aws:${service}:${service === 'iam' ? '' : region}:123456789012:${resource}`;
}

async function validEvidence() {
  const { contract, fingerprints, workloads, autoscaling } =
    await loadSources();
  const imageUri = `123456789012.dkr.ecr.eu-central-1.amazonaws.com/pertexo@sha256:${'1'.repeat(64)}`;
  const rawObservationId = (region, kind) => `${region}:${kind}`;
  const rawObservations = [
    contract.primaryRegion,
    contract.recoveryRegion,
  ].flatMap((region) =>
    contract.evidence.requiredRawObservationKinds.map((kind) => ({
      id: rawObservationId(region, kind),
      source: 'aws-api',
      region,
      kind,
      reference: `evidence://run-123/${region}/${kind}.json`,
      sha256: '9'.repeat(64),
    })),
  );
  rawObservations.push(
    ...contract.evidence.requiredRecoveryRawObservationKinds.map((kind) => ({
      id: rawObservationId(contract.recoveryRegion, kind),
      source: 'aws-api',
      region: contract.recoveryRegion,
      kind,
      reference: `evidence://run-123/${contract.recoveryRegion}/${kind}.json`,
      sha256: '9'.repeat(64),
    })),
  );
  const regions = {};
  for (const region of [contract.primaryRegion, contract.recoveryRegion]) {
    const workloadEvidence = {};
    for (const [name, workload] of Object.entries(workloads.workloads)) {
      workloadEvidence[name] = {
        source: 'aws-api',
        rawObservationId: rawObservationId(region, 'ecs'),
        taskDefinitionArn: arn(
          'ecs',
          region,
          `task-definition/pertexo-${name}:42`,
        ),
        imageUri,
        taskRole: {
          source: 'aws-api',
          rawObservationId: rawObservationId(region, 'iam'),
          arn: arn('iam', region, `role/pertexo-${region}-${name}-task`),
          policySha256: '2'.repeat(64),
          hasWildcardAction: false,
          hasSensitiveWildcardResource: false,
        },
        executionRole: {
          source: 'aws-api',
          rawObservationId: rawObservationId(region, 'iam'),
          arn: arn('iam', region, `role/pertexo-${region}-${name}-execution`),
          policySha256: '3'.repeat(64),
          hasWildcardAction: false,
          hasSensitiveWildcardResource: false,
        },
        configurationReferences: workload.configuration.map((name) => ({
          source: 'aws-api',
          rawObservationId: rawObservationId(region, 'ssm'),
          name,
          arn: arn('ssm', region, `parameter/pertexo/${name}`),
          executionRoleCanRead: true,
        })),
        secretReferences: workload.secrets.map((name) => ({
          source: 'aws-api',
          rawObservationId: rawObservationId(region, 'secrets-manager'),
          kmsRawObservationId: rawObservationId(region, 'kms'),
          name,
          arn: arn('secretsmanager', region, `secret:pertexo/${name}`),
          kmsKeyArn: arn(
            'kms',
            region,
            'key/00000000-0000-0000-0000-000000000001',
          ),
          executionRoleCanDecrypt: true,
          executionRoleCanRead: true,
        })),
        ...(workload.kind === 'service'
          ? {
              service: {
                source: 'aws-api',
                rawObservationId: rawObservationId(region, 'ecs'),
                desiredCount: workload.desiredCount[region],
                runningCount: workload.desiredCount[region],
                pendingCount: 0,
                deploymentStatus: 'COMPLETED',
                minimumHealthyPercent: 100,
                maximumPercent: 200,
                healthCheckGracePeriodSeconds: 60,
                drainSeconds: 120,
              },
            }
          : {}),
        ...(contract.telemetry.requiredWorkloads.includes(name)
          ? {
              telemetry: {
                source: 'aws-api',
                rawObservationId: rawObservationId(region, 'cloudwatch'),
                publishedMetricNames: [`pertexo.${name}.health`],
                alarmArns: [
                  arn('cloudwatch', region, `alarm:pertexo-${name}-health`),
                ],
                alarmActionsEnabled: true,
              },
            }
          : {}),
      };
    }
    regions[region] = {
      network: {
        source: 'aws-api',
        rawObservationId: rawObservationId(region, 'ec2-network'),
        assignPublicIp: false,
        availabilityZones:
          region === contract.primaryRegion
            ? [`${region}a`, `${region}b`]
            : [`${region}a`],
        subnetIds: ['subnet-1234abcd'],
        securityGroupIds: ['sg-1234abcd'],
        routeAndSecurityGroupPolicySha256: '6'.repeat(64),
        reachableRegionalEndpoints: contract.network.requiredRegionalEndpoints,
        egressByWorkload: contract.network.egressByWorkload,
        publicIngress:
          region === contract.primaryRegion
            ? [
                {
                  ...contract.network.publicIngress,
                  sourceSecurityGroupIds: ['sg-8765abcd'],
                },
              ]
            : [],
      },
      workloads: workloadEvidence,
      autoscaling: Object.fromEntries(
        Object.entries(autoscaling.services).map(([name, service]) => [
          name,
          {
            source: 'aws-api',
            rawObservationId: rawObservationId(
              region,
              'application-autoscaling',
            ),
            alarmRawObservationId: rawObservationId(region, 'cloudwatch'),
            resourceId: `service/pertexo/${name}`,
            minCapacity: service.capacity[region].min,
            maxCapacity: service.capacity[region].max,
            scaleOutCooldownSeconds: service.scaleOutCooldownSeconds,
            scaleInCooldownSeconds: service.scaleInCooldownSeconds,
            configuredSlotsPerTask: service.configuredSlotsPerTask ?? null,
            policies: service.signals.map((signal) => ({
              signal: signal.name,
              metric: signal.metric,
              statistic: signal.statistic,
              threshold: signal.threshold,
              unit: signal.unit,
              periodSeconds: signal.periodSeconds,
              evaluationPeriods: signal.evaluationPeriods,
              normalization: signal.normalization ?? null,
              alarmArn: arn(
                'cloudwatch',
                region,
                `alarm:pertexo-${name}-${signal.name}`,
              ),
              enabled: true,
            })),
          },
        ]),
      ),
    };
  }
  return {
    schemaVersion: 2,
    source: 'aws-api',
    contractFingerprints: fingerprints,
    observedAt: now.toISOString(),
    release: {
      commitSha: '4'.repeat(40),
      imageUri,
      imageRawObservationIds: Object.fromEntries(
        [contract.primaryRegion, contract.recoveryRegion].map((region) => [
          region,
          rawObservationId(region, 'ecr'),
        ]),
      ),
    },
    collection: {
      verificationStatus: 'requires-independent-authentication',
      collectorIdentityArn: arn(
        'iam',
        contract.primaryRegion,
        'role/pertexo-evidence-collector',
      ),
      runId: 'release-20260830-123',
      startedAt: '2026-08-30T11:45:00.000Z',
      completedAt: '2026-08-30T11:59:00.000Z',
      rawObservations,
    },
    regions,
    migration: {
      source: 'aws-api',
      rawObservationId: rawObservationId(contract.primaryRegion, 'ecs'),
      workload: 'migration',
      taskArn: arn('ecs', contract.primaryRegion, 'task/pertexo/abc123'),
      taskDefinitionArn: arn(
        'ecs',
        contract.primaryRegion,
        'task-definition/pertexo-migration:42',
      ),
      exitCode: 0,
      maximumObservedConcurrentTasks: 1,
      successfulTaskArns: [
        arn('ecs', contract.primaryRegion, 'task/pertexo/abc123'),
      ],
      startedAt: '2026-08-30T11:49:00.000Z',
      stoppedAt: '2026-08-30T11:50:00.000Z',
      servicesUpdatedAt: '2026-08-30T11:51:00.000Z',
    },
    recoveryWriterFence: {
      source: 'aws-api',
      ecsRawObservationId: rawObservationId(contract.recoveryRegion, 'ecs'),
      networkRawObservationId: rawObservationId(
        contract.recoveryRegion,
        'ec2-network',
      ),
      routeRawObservationId: rawObservationId(
        contract.recoveryRegion,
        'route53',
      ),
      loadBalancerRawObservationId: rawObservationId(
        contract.recoveryRegion,
        'elastic-load-balancing-v2',
      ),
      eventBridgeRawObservationId: rawObservationId(
        contract.recoveryRegion,
        'eventbridge',
      ),
      queueRawObservationId: rawObservationId(contract.recoveryRegion, 'sqs'),
      region: contract.recoveryRegion,
      ingressClosed: true,
      writerDesiredCounts: Object.fromEntries(
        contract.recoveryWriterFence.writerWorkloads.map((name) => [name, 0]),
      ),
      routeAndQueuePolicySha256: '5'.repeat(64),
    },
  };
}

test('accepts fresh AWS evidence for the exact reviewed contract', async () => {
  await validateExternalPlatformEvidence(await validEvidence(), { now });
});

const driftCases = [
  {
    name: 'workload egress drift',
    mutate(evidence) {
      evidence.regions['eu-central-1'].network.egressByWorkload.worker.push(
        'open-internet',
      );
    },
    message: /workload egress policy drifted/u,
  },
  {
    name: 'reused task roles',
    mutate(evidence) {
      const workloads = evidence.regions['eu-central-1'].workloads;
      workloads.worker.taskRole.arn = workloads.api.taskRole.arn;
    },
    message: /task roles must be distinct/u,
  },
  {
    name: 'public task addresses',
    mutate(evidence) {
      evidence.regions['eu-central-1'].network.assignPublicIp = true;
    },
    message: /must not receive public IPs/u,
  },
  {
    name: 'missing KMS decrypt permission',
    mutate(evidence) {
      evidence.regions[
        'eu-central-1'
      ].workloads.api.secretReferences[0].executionRoleCanDecrypt = false;
    },
    message: /execution-role KMS permission/u,
  },
  {
    name: 'unhealthy service rollout',
    mutate(evidence) {
      evidence.regions['eu-central-1'].workloads.worker.service.pendingCount =
        1;
    },
    message: /deployment is not healthy/u,
  },
  {
    name: 'disabled alarm actions',
    mutate(evidence) {
      evidence.regions[
        'eu-central-1'
      ].workloads.api.telemetry.alarmActionsEnabled = false;
    },
    message: /enabled alarm wiring/u,
  },
  {
    name: 'scaling target drift',
    mutate(evidence) {
      evidence.regions['eu-central-1'].autoscaling.worker.maxCapacity += 1;
    },
    message: /scaling target drifted/u,
  },
  {
    name: 'overlapping migrations',
    mutate(evidence) {
      evidence.migration.maximumObservedConcurrentTasks = 2;
    },
    message: /non-exclusive/u,
  },
  {
    name: 'open recovery writer',
    mutate(evidence) {
      evidence.recoveryWriterFence.writerDesiredCounts.worker = 1;
    },
    message: /desired-count fence is not closed/u,
  },
  {
    name: 'stale evidence',
    mutate(evidence) {
      evidence.observedAt = '2026-08-30T10:00:00.000Z';
    },
    message: /evidence is stale/u,
  },
];

for (const driftCase of driftCases) {
  test(`rejects ${driftCase.name}`, async () => {
    const evidence = await validEvidence();
    driftCase.mutate(evidence);
    await assert.rejects(
      validateExternalPlatformEvidence(evidence, { now }),
      driftCase.message,
    );
  });
}

test('requires all reviewed input fingerprints', async () => {
  for (const mutate of [
    (evidence) => delete evidence.contractFingerprints.workloadsSha256,
    (evidence) => {
      evidence.contractFingerprints.autoscalingSha256 = '0'.repeat(64);
    },
    (evidence) => {
      evidence.contractFingerprints.extraSha256 = '0'.repeat(64);
    },
  ]) {
    const evidence = await validEvidence();
    mutate(evidence);
    await assert.rejects(
      validateExternalPlatformEvidence(evidence, { now }),
      /does not match all reviewed deployment contracts/u,
    );
  }
});

test('rejects missing provenance and self-claimed verification', async () => {
  const missing = await validEvidence();
  delete missing.collection;
  await assert.rejects(
    validateExternalPlatformEvidence(missing, { now }),
    /collection is missing/u,
  );

  const selfAttested = await validEvidence();
  selfAttested.collection.verificationStatus = 'verified-by-this-document';
  await assert.rejects(
    validateExternalPlatformEvidence(selfAttested, { now }),
    /must not self-attest verified remote state/u,
  );
});

test('requires exact, distinct raw observation coverage', async () => {
  const missing = await validEvidence();
  missing.collection.rawObservations.pop();
  await assert.rejects(
    validateExternalPlatformEvidence(missing, { now }),
    /coverage must exactly match/u,
  );

  const duplicated = await validEvidence();
  duplicated.collection.rawObservations[1].id =
    duplicated.collection.rawObservations[0].id;
  await assert.rejects(
    validateExternalPlatformEvidence(duplicated, { now }),
    /IDs must be nonempty and distinct/u,
  );
});

test('binds observed roles and workloads to their raw records', async () => {
  const evidence = await validEvidence();
  evidence.regions['eu-central-1'].workloads.api.taskRole.rawObservationId =
    'eu-central-1:ecs';
  await assert.rejects(
    validateExternalPlatformEvidence(evidence, { now }),
    /task role must reference its eu-central-1 iam raw observation/u,
  );

  const image = await validEvidence();
  image.release.imageRawObservationIds['eu-west-1'] = 'eu-central-1:ecr';
  await assert.rejects(
    validateExternalPlatformEvidence(image, { now }),
    /release image must reference its eu-west-1 ecr raw observation/u,
  );
});

test('requires exact SSM references and execution-role permission', async () => {
  const missing = await validEvidence();
  missing.regions['eu-central-1'].workloads.api.configurationReferences.pop();
  await assert.rejects(
    validateExternalPlatformEvidence(missing, { now }),
    /configuration references drifted/u,
  );

  const unreadable = await validEvidence();
  unreadable.regions[
    'eu-central-1'
  ].workloads.api.configurationReferences[0].executionRoleCanRead = false;
  await assert.rejects(
    validateExternalPlatformEvidence(unreadable, { now }),
    /configuration .*execution-role read permission/u,
  );
});

test('requires exact autoscaling metrics, windows, normalization, and cooldowns', async () => {
  for (const mutate of [
    (actual) => {
      actual.policies[0].metric = 'wrong.metric';
    },
    (actual) => {
      actual.policies[0].threshold += 1;
    },
    (actual) => {
      actual.policies[0].periodSeconds += 60;
    },
    (actual) => {
      actual.policies[1].normalization = 'metric/configuredSlotsPerTask';
    },
    (actual) => {
      actual.scaleInCooldownSeconds += 1;
    },
  ]) {
    const evidence = await validEvidence();
    const actual = evidence.regions['eu-central-1'].autoscaling.worker;
    mutate(actual);
    await assert.rejects(
      validateExternalPlatformEvidence(evidence, { now }),
      /scaling policy drifted|scaling cooldown or capacity normalization drifted/u,
    );
  }
});

test('rejects nonpositive or noninteger migration concurrency evidence', async () => {
  for (const count of [null, -1, 0, 0.5, '1']) {
    const evidence = await validEvidence();
    evidence.migration.maximumObservedConcurrentTasks = count;
    await assert.rejects(
      validateExternalPlatformEvidence(evidence, { now }),
      /migration execution was unsuccessful or non-exclusive/u,
    );
  }
});

test('binds migration identity, success, and finite ordered times', async () => {
  const taskDefinition = await validEvidence();
  taskDefinition.migration.taskDefinitionArn = arn(
    'ecs',
    'eu-central-1',
    'task-definition/pertexo-other:42',
  );
  await assert.rejects(
    validateExternalPlatformEvidence(taskDefinition, { now }),
    /bind its one successful task/u,
  );

  const successfulTask = await validEvidence();
  successfulTask.migration.successfulTaskArns = [];
  await assert.rejects(
    validateExternalPlatformEvidence(successfulTask, { now }),
    /bind its one successful task/u,
  );

  for (const mutate of [
    (migration) => {
      migration.startedAt = 'not-a-time';
    },
    (migration) => {
      migration.stoppedAt = null;
    },
    (migration) => {
      migration.startedAt = '2026-08-30T11:52:00.000Z';
    },
  ]) {
    const evidence = await validEvidence();
    mutate(evidence.migration);
    await assert.rejects(
      validateExternalPlatformEvidence(evidence, { now }),
      /migration .* time is invalid|serving services were updated before migration completed/u,
    );
  }
});
