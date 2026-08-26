/* global process */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(
  await readFile(resolve(root, 'infrastructure/ecs/workloads.json'), 'utf8'),
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
  ['migration', 'packages/database/dist/migrate.js'],
]);
const credentialPattern =
  /(DATABASE_.*_URL|REDIS_URL|SECRET.*KEY|CLIENT_SECRET|TRANSACTION_KEY|ACCESS_KEY_ID)$/u;

if (!dockerfile.includes('USER 10001:10001'))
  throw new Error('runtime image must be non-root');
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
