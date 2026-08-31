/* global process */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const renderer = resolve(
  root,
  'infrastructure/ecs/render-task-definitions.mjs',
);
const manifest = JSON.parse(
  await readFile(resolve(root, 'infrastructure/ecs/workloads.json'), 'utf8'),
);
const image = `registry.example.invalid/pertexo@sha256:${'a'.repeat(64)}`;
const renderEnvironment = {
  ...process.env,
  AWS_REGION: 'eu-central-1',
  ECS_CONFIG_PREFIX_ARN:
    'arn:aws:ssm:eu-central-1:000000000000:parameter/pertexo',
  ECS_EXECUTION_ROLE_ARN_PREFIX:
    'arn:aws:iam::000000000000:role/pertexo-execution',
  ECS_IMAGE_URI: image,
  ECS_LOG_GROUP: '/pertexo/application',
  ECS_SECRET_PREFIX_ARN:
    'arn:aws:secretsmanager:eu-central-1:000000000000:secret:pertexo',
  ECS_TASK_ROLE_ARN_PREFIX: 'arn:aws:iam::000000000000:role/pertexo-task',
};
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'pertexo-ecs-render-'));

async function render(directory) {
  await execFileAsync(process.execPath, [renderer, directory], {
    cwd: root,
    env: renderEnvironment,
  });
}

try {
  const first = resolve(temporaryRoot, 'first');
  const second = resolve(temporaryRoot, 'second');
  await render(first);
  await render(second);

  const expectedFiles = Object.keys(manifest.workloads)
    .sort()
    .map((name) => `${name}.json`);
  const firstFiles = (await readdir(first)).sort();
  const secondFiles = (await readdir(second)).sort();
  if (JSON.stringify(firstFiles) !== JSON.stringify(expectedFiles))
    throw new Error(
      'rendered task-definition file set does not match workloads',
    );
  if (JSON.stringify(secondFiles) !== JSON.stringify(expectedFiles))
    throw new Error(
      'repeated render task-definition file set does not match workloads',
    );

  for (const file of expectedFiles) {
    const firstBytes = await readFile(resolve(first, file));
    const secondBytes = await readFile(resolve(second, file));
    if (!firstBytes.equals(secondBytes))
      throw new Error(`${file} is not rendered deterministically`);
    const task = JSON.parse(firstBytes.toString('utf8'));
    const container = task.containerDefinitions?.[0];
    if (container?.image !== image)
      throw new Error(`${file} does not retain the digest-qualified image`);
    if (container.user !== '10001:10001' || !container.readonlyRootFilesystem)
      throw new Error(
        `${file} weakens the runtime filesystem or user boundary`,
      );
    if (container.linuxParameters?.initProcessEnabled !== true)
      throw new Error(`${file} must enable the ECS init process`);
    if (
      task.taskRoleArn !==
      `${renderEnvironment.ECS_TASK_ROLE_ARN_PREFIX}/${container.name}`
    )
      throw new Error(`${file} does not use its workload-specific task role`);
    if (
      task.executionRoleArn !==
      `${renderEnvironment.ECS_EXECUTION_ROLE_ARN_PREFIX}/${container.name}`
    )
      throw new Error(
        `${file} does not use its workload-specific execution role`,
      );
  }

  try {
    await execFileAsync(
      process.execPath,
      [renderer, resolve(temporaryRoot, 'invalid')],
      {
        cwd: root,
        env: {
          ...renderEnvironment,
          ECS_IMAGE_URI: 'registry.example.invalid/pertexo:latest',
        },
      },
    );
    throw new Error('renderer accepted a mutable image reference');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'renderer accepted a mutable image reference'
    )
      throw error;
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr)
        : '';
    if (!stderr.includes('ECS_IMAGE_URI must be digest-qualified')) throw error;
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(
  'ECS task-definition rendering is deterministic and digest-pinned.\n',
);
