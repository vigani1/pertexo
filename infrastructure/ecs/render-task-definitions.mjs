/* global process */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(
  await readFile(resolve(root, 'infrastructure/ecs/workloads.json'), 'utf8'),
);
const outputDirectory = resolve(process.argv[2] ?? 'dist/ecs-task-definitions');
const requiredEnvironment = [
  'ECS_EXECUTION_ROLE_ARN_PREFIX',
  'ECS_CONFIG_PREFIX_ARN',
  'ECS_IMAGE_URI',
  'ECS_LOG_GROUP',
  'ECS_SECRET_PREFIX_ARN',
  'ECS_TASK_ROLE_ARN_PREFIX',
];
for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
if (
  !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(
    process.env.ECS_IMAGE_URI,
  )
) {
  throw new Error(
    'ECS_IMAGE_URI must be digest-qualified (<repository>@sha256:<64 lowercase hex characters>)',
  );
}

await mkdir(outputDirectory, { recursive: true });
for (const [name, workload] of Object.entries(manifest.workloads).sort(
  ([left], [right]) => left.localeCompare(right),
)) {
  const container = {
    name,
    image: process.env.ECS_IMAGE_URI,
    essential: true,
    readonlyRootFilesystem: true,
    user: '10001:10001',
    command: workload.command,
    environment: Object.entries(workload.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ name: key, value })),
    secrets: [
      ...[...workload.configuration].sort().map((configuration) => ({
        name: configuration,
        valueFrom: `${process.env.ECS_CONFIG_PREFIX_ARN}/${name}/${configuration}`,
      })),
      ...[...workload.secrets].sort().map((secret) => ({
        name: secret,
        valueFrom: `${process.env.ECS_SECRET_PREFIX_ARN}/${name}/${secret}`,
      })),
    ],
    mountPoints: [
      { sourceVolume: 'tmp', containerPath: '/tmp', readOnly: false },
    ],
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': process.env.ECS_LOG_GROUP,
        'awslogs-region': process.env.AWS_REGION ?? 'eu-central-1',
        'awslogs-stream-prefix': name,
      },
    },
    ...(workload.port === undefined
      ? {}
      : { portMappings: [{ containerPort: workload.port, protocol: 'tcp' }] }),
    ...(workload.healthCheck === undefined
      ? {}
      : {
          healthCheck: {
            command: workload.healthCheck,
            interval: 30,
            retries: 3,
            startPeriod: 30,
            timeout: 5,
          },
        }),
  };
  const taskDefinition = {
    family: `pertexo-${name}`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: manifest.platform.networkMode,
    cpu: manifest.platform.cpu,
    memory: manifest.platform.memory,
    executionRoleArn: `${process.env.ECS_EXECUTION_ROLE_ARN_PREFIX}/${name}`,
    taskRoleArn: `${process.env.ECS_TASK_ROLE_ARN_PREFIX}/${name}`,
    runtimePlatform: {
      cpuArchitecture: manifest.platform.architecture,
      operatingSystemFamily: manifest.platform.operatingSystem,
    },
    containerDefinitions: [container],
    volumes: [{ name: 'tmp' }],
    tags: [
      { key: 'pertexo:workload', value: name },
      { key: 'pertexo:kind', value: workload.kind },
    ],
  };
  await writeFile(
    resolve(outputDirectory, `${name}.json`),
    `${JSON.stringify(taskDefinition, null, 2)}\n`,
  );
}
