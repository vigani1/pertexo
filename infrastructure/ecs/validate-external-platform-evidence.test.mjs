import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  loadDeploymentContract,
  validateExternalPlatformEvidence,
} from './validate-external-platform-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const now = new Date('2026-08-30T12:00:00.000Z');

async function loadSources() {
  const [{ bytes, contract }, workloads, autoscaling] = await Promise.all([
    loadDeploymentContract(),
    readFile(resolve(root, 'infrastructure/ecs/workloads.json'), 'utf8').then(
      JSON.parse,
    ),
    readFile(resolve(root, 'infrastructure/ecs/autoscaling.json'), 'utf8').then(
      JSON.parse,
    ),
  ]);
  return { bytes, contract, workloads, autoscaling };
}

function arn(service, region, resource) {
  return `arn:aws:${service}:${service === 'iam' ? '' : region}:123456789012:${resource}`;
}

async function validEvidence() {
  const { bytes, contract, workloads, autoscaling } = await loadSources();
  const imageUri = `123456789012.dkr.ecr.eu-central-1.amazonaws.com/pertexo@sha256:${'1'.repeat(64)}`;
  const regions = {};
  for (const region of [contract.primaryRegion, contract.recoveryRegion]) {
    const workloadEvidence = {};
    for (const [name, workload] of Object.entries(workloads.workloads)) {
      workloadEvidence[name] = {
        source: 'aws-api',
        taskDefinitionArn: arn(
          'ecs',
          region,
          `task-definition/pertexo-${name}:42`,
        ),
        imageUri,
        taskRole: {
          source: 'aws-api',
          arn: arn('iam', region, `role/pertexo-${region}-${name}-task`),
          policySha256: '2'.repeat(64),
          hasWildcardAction: false,
          hasSensitiveWildcardResource: false,
        },
        executionRole: {
          source: 'aws-api',
          arn: arn('iam', region, `role/pertexo-${region}-${name}-execution`),
          policySha256: '3'.repeat(64),
          hasWildcardAction: false,
          hasSensitiveWildcardResource: false,
        },
        secretReferences: workload.secrets.map((name) => ({
          source: 'aws-api',
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
            resourceId: `service/pertexo/${name}`,
            minCapacity: service.capacity[region].min,
            maxCapacity: service.capacity[region].max,
            policies: service.signals.map((signal) => ({
              signal: signal.name,
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
    schemaVersion: 1,
    source: 'aws-api',
    contractSha256: createHash('sha256').update(bytes).digest('hex'),
    observedAt: now.toISOString(),
    release: { commitSha: '4'.repeat(40), imageUri },
    regions,
    migration: {
      source: 'aws-api',
      workload: 'migration',
      taskArn: arn('ecs', contract.primaryRegion, 'task/pertexo/abc123'),
      taskDefinitionArn: arn(
        'ecs',
        contract.primaryRegion,
        'task-definition/pertexo-migration:42',
      ),
      exitCode: 0,
      maximumObservedConcurrentTasks: 1,
      stoppedAt: '2026-08-30T11:50:00.000Z',
      servicesUpdatedAt: '2026-08-30T11:51:00.000Z',
    },
    recoveryWriterFence: {
      source: 'aws-api',
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
