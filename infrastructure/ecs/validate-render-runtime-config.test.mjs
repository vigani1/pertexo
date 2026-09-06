/* global Buffer, process */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const renderer = resolve(
  root,
  'infrastructure/ecs/render-task-definitions.mjs',
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

// This list is intentionally a literal deployment assertion. It mirrors the
// active queue contract and must be reviewed when a job is activated or retired.
const activeQueueJobNames = [
  'advance-workflow-run',
  'execute-node-attempt',
  'execute-preview-attempt',
  'reconcile-preview-attempt',
  'reconcile-unknown-outcome',
  'replay-workflow-run',
  'reconcile-workflow-triggers',
  'deliver-run-failure-notification',
];

const productionCohorts = ['core', 'merge_v3_activation'];

const parserScript = String.raw`
  const environment = JSON.parse(process.env.PERTEXO_RENDERED_ENV ?? '{}');
  const role = process.env.PERTEXO_CONFIG_ROLE;
  const config = role === 'api'
    ? (await import('./apps/api/src/platform/config/api-config.ts')).parseApiConfig(environment)
    : (await import('./apps/worker/src/config/worker-config.ts')).parseWorkerConfig(environment);
  const result = {
    cohort: config.nodeCompatibilityCohort,
    serviceVersion: config.observability.serviceVersion,
  };
  if (role === 'api') {
    result.hasArtifactStore = config.artifacts !== undefined;
    result.connectionKmsKeyReference = config.connections?.kmsKeyReference;
    result.connectionKmsRegion = config.connections?.region;
    result.trustedProxyCidrs = config.trustedProxyCidrs;
  } else {
    result.enabledJobNames = config.outboxDispatcher.enabledJobNames;
    result.hasConnectionEncryption = config.connectionEncryption !== undefined;
    result.hasArtifactStore = config.artifactStore !== undefined;
  }
  process.stdout.write(JSON.stringify(result));
`;

async function render(directory) {
  await execFileAsync(process.execPath, [renderer, directory], {
    cwd: root,
    env: renderEnvironment,
  });
}

async function loadManifest() {
  return JSON.parse(
    await readFile(resolve(root, 'infrastructure/ecs/workloads.json'), 'utf8'),
  );
}

function scalarEnvironment(value) {
  assert.equal(typeof value, 'string');
  return value;
}

function syntheticValue(name, cohort) {
  const values = {
    ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
    ARTIFACT_STORE_BUCKET: 'pertexo-artifacts-primary',
    ARTIFACT_STORE_ENDPOINT: 'https://objects-primary.example.test',
    ARTIFACT_STORE_FORCE_PATH_STYLE: 'false',
    ARTIFACT_STORE_REGION: 'eu-central-1',
    ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID: 'recovery-access',
    ARTIFACT_STORE_RECOVERY_BUCKET: 'pertexo-artifacts-recovery',
    ARTIFACT_STORE_RECOVERY_ENDPOINT: 'https://objects-recovery.example.test',
    ARTIFACT_STORE_RECOVERY_FORCE_PATH_STYLE: 'false',
    ARTIFACT_STORE_RECOVERY_REGION: 'eu-west-1',
    ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
    ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY: 'recovery-secret',
    CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
    CONNECTION_KMS_REGION: 'eu-central-1',
    DATABASE_API_URL:
      'postgresql://api:password@postgres.example.test:5432/pertexo',
    DATABASE_DISPATCHER_URL:
      'postgresql://dispatcher:password@postgres.example.test:5432/pertexo',
    DATABASE_WORKER_URL:
      'postgresql://worker:password@postgres.example.test:5432/pertexo',
    OIDC_AUTHORIZATION_ENDPOINT:
      'https://identity.example.test/oauth2/authorize',
    OIDC_CLIENT_ID: 'pertexo-api',
    OIDC_CLIENT_SECRET: 'oidc-client-secret',
    OIDC_ISSUER: 'https://identity.example.test',
    OIDC_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
    OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/oidc/callback',
    OIDC_TOKEN_ENDPOINT: 'https://identity.example.test/oauth2/token',
    OIDC_TRANSACTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    OIDC_TRANSACTION_KEY_VERSION: 'v1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test',
    OUTBOX_DISPATCH_JOB_NAMES: activeQueueJobNames.join(','),
    REDIS_URL: 'rediss://redis.example.test:6380/0',
    SERVICE_VERSION: 'release-2026-09-06',
    TRUST_PROXY_CIDRS: '10.0.0.0/8, 2001:db8::/32',
    NODE_COMPATIBILITY_COHORT: cohort,
  };
  const value = values[name];
  assert.notEqual(value, undefined, `no synthetic value for ${name}`);
  return value;
}

function resolveRenderedEnvironment(workloadName, workload, task, cohort) {
  const container = task.containerDefinitions?.[0];
  assert.ok(container, `${workloadName} must have a container definition`);
  const environment = Object.fromEntries(
    (container.environment ?? []).map(({ name, value }) => [
      name,
      scalarEnvironment(value),
    ]),
  );
  const renderedNames = new Set(
    (container.secrets ?? []).map(({ name }) => name),
  );
  const references = new Map(
    (container.secrets ?? []).map(({ name, valueFrom }) => [name, valueFrom]),
  );
  for (const name of [...workload.configuration, ...workload.secrets]) {
    assert.ok(
      renderedNames.has(name),
      `${workloadName} does not render ${name} through ECS secret/config injection`,
    );
    environment[name] = syntheticValue(name, cohort);
  }
  for (const name of workload.configuration) {
    assert.equal(
      references.get(name),
      `${renderEnvironment.ECS_CONFIG_PREFIX_ARN}/${workloadName}/${name}`,
      `${workloadName} configuration ${name} must use the SSM configuration prefix`,
    );
  }
  for (const name of workload.secrets) {
    assert.equal(
      references.get(name),
      `${renderEnvironment.ECS_SECRET_PREFIX_ARN}/${workloadName}/${name}`,
      `${workloadName} secret ${name} must use the Secrets Manager prefix`,
    );
  }
  return environment;
}

async function parseRole(role, environment) {
  const result = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', parserScript],
    {
      cwd: root,
      env: {
        ...process.env,
        PERTEXO_CONFIG_ROLE: role,
        PERTEXO_RENDERED_ENV: JSON.stringify(environment),
      },
    },
  );
  return JSON.parse(result.stdout);
}

test('rendered API and worker definitions satisfy their public production parsers', async () => {
  const manifest = await loadManifest();
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), 'pertexo-ecs-runtime-config-'),
  );
  try {
    await render(temporaryRoot);
    const files = (await readdir(temporaryRoot)).sort();
    assert.deepEqual(
      files,
      Object.keys(manifest.workloads)
        .sort()
        .map((name) => `${name}.json`),
    );
    const tasks = {};
    for (const name of ['api', 'worker']) {
      tasks[name] = JSON.parse(
        await readFile(resolve(temporaryRoot, `${name}.json`), 'utf8'),
      );
    }

    for (const cohort of productionCohorts) {
      const apiConfig = await parseRole(
        'api',
        resolveRenderedEnvironment(
          'api',
          manifest.workloads.api,
          tasks.api,
          cohort,
        ),
      );
      assert.equal(apiConfig.cohort, cohort);
      assert.equal(apiConfig.hasArtifactStore, true);
      assert.equal(
        apiConfig.connectionKmsKeyReference,
        'alias/pertexo-connections',
      );
      assert.equal(apiConfig.connectionKmsRegion, 'eu-central-1');
      assert.deepEqual(apiConfig.trustedProxyCidrs, [
        '10.0.0.0/8',
        '2001:db8::/32',
      ]);
      assert.equal(apiConfig.serviceVersion, 'release-2026-09-06');

      const workerConfig = await parseRole(
        'worker',
        resolveRenderedEnvironment(
          'worker',
          manifest.workloads.worker,
          tasks.worker,
          cohort,
        ),
      );
      assert.equal(workerConfig.cohort, cohort);
      assert.deepEqual(workerConfig.enabledJobNames, activeQueueJobNames);
      assert.equal(workerConfig.serviceVersion, 'release-2026-09-06');
      if (cohort === 'merge_v3_activation') {
        assert.equal(workerConfig.hasConnectionEncryption, true);
        assert.equal(workerConfig.hasArtifactStore, true);
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
