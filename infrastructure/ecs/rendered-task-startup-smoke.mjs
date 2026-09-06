/* global Buffer, fetch, process, setTimeout */

/**
 * Start the API and worker exactly as rendered ECS tasks, using only disposable
 * local service endpoints.  ECS resolves `configuration` and `secrets` after
 * task-definition rendering; this harness performs that resolution from the
 * explicit local fixture below and refuses to accept undeclared environment
 * values.  The only additional values are the CA trust path for the local TLS
 * object-store bridge and Docker's host-gateway entry.
 *
 * Prerequisites:
 *   1. Build a production image and pass its local tag as IWA02_IMAGE.  The
 *      tag is resolved once to a digest-qualified reference before rendering
 *      and is never used to launch a container.
 *   2. Start the isolated PostgreSQL, Redis, and artifact-store services.
 *   3. Migrate IWA02_DATABASE_NAME to the image's expected migration head.
 *
 * Example:
 *   IWA02_IMAGE=pertexo-iwa02-rendered-smoke:local \
 *   IWA02_DATABASE_NAME=pertexo_iwa02_rendered \
 *   node infrastructure/ecs/rendered-task-startup-smoke.mjs
 *
 * `IWA02_RUNTIME_COHORT` selects the rendered cohort whose API/worker pair is
 * started against the supplied database (default: `core`).  A database's
 * compatibility pointer can serve only the cohort it has been rolled out to;
 * the harness still resolves and validates every production cohort on every
 * run, and can be repeated with the matching database for the other cohort.
 */

import { execFile, execFileSync } from 'node:child_process';
import {
  createServer as createHttpServer,
  request as httpRequest,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const renderer = resolve(
  root,
  'infrastructure/ecs/render-task-definitions.mjs',
);
const image = requiredEnvironment('IWA02_IMAGE');
const resolvedImage = resolveImage(image);
const databaseName =
  process.env.IWA02_DATABASE_NAME ?? 'pertexo_iwa02_rendered';
const databasePort = integerEnvironment('IWA02_DATABASE_PORT', 15439);
const redisPort = integerEnvironment('IWA02_REDIS_PORT', 16389);
const artifactStorePort = integerEnvironment(
  'IWA02_ARTIFACT_STORE_PORT',
  19090,
);
const databaseHost = process.env.IWA02_DATABASE_HOST ?? 'host.docker.internal';
const redisHost = process.env.IWA02_REDIS_HOST ?? 'host.docker.internal';

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
const runtimeCohort = process.env.IWA02_RUNTIME_COHORT ?? 'core';
if (!productionCohorts.includes(runtimeCohort))
  throw new Error(
    `IWA02_RUNTIME_COHORT must be one of ${productionCohorts.join(', ')}`,
  );
const renderEnvironment = {
  ...process.env,
  AWS_REGION: 'eu-central-1',
  ECS_CONFIG_PREFIX_ARN:
    process.env.ECS_CONFIG_PREFIX_ARN ??
    'arn:aws:ssm:eu-central-1:000000000000:parameter/pertexo',
  ECS_EXECUTION_ROLE_ARN_PREFIX:
    process.env.ECS_EXECUTION_ROLE_ARN_PREFIX ??
    'arn:aws:iam::000000000000:role/pertexo-execution',
  ECS_IMAGE_URI: resolvedImage.reference,
  ECS_LOG_GROUP: process.env.ECS_LOG_GROUP ?? '/pertexo/application',
  ECS_SECRET_PREFIX_ARN:
    process.env.ECS_SECRET_PREFIX_ARN ??
    'arn:aws:secretsmanager:eu-central-1:000000000000:secret:pertexo',
  ECS_TASK_ROLE_ARN_PREFIX:
    process.env.ECS_TASK_ROLE_ARN_PREFIX ??
    'arn:aws:iam::000000000000:role/pertexo-task',
};

const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), 'pertexo-iwa02-rendered-'),
);
const containers = new Set();
let objectStoreBridge;
let telemetryServer;

try {
  const manifest = JSON.parse(
    await readFile(resolve(root, 'infrastructure/ecs/workloads.json'), 'utf8'),
  );
  await render(temporaryRoot);
  const tasks = {};
  for (const role of ['api', 'worker']) {
    tasks[role] = JSON.parse(
      await readFile(resolve(temporaryRoot, `${role}.json`), 'utf8'),
    );
  }

  telemetryServer = await createTelemetryServer();
  objectStoreBridge = await createObjectStoreBridge();

  const baseValues = localFixtureValues(
    telemetryServer.port,
    objectStoreBridge.port,
  );
  const coreApiEnvironment = resolveTaskEnvironment(
    'api',
    manifest.workloads.api,
    tasks.api,
    'core',
    baseValues,
  );
  await assertRoleConfigurationNegative(
    coreApiEnvironment,
    objectStoreBridge.caPath,
  );
  process.stdout.write(
    'IWA02 negative: rendered API environment rejects missing CONNECTION_KMS_REGION.\n',
  );

  const environments = {};
  for (const cohort of productionCohorts) {
    environments[cohort] = {
      api: resolveTaskEnvironment(
        'api',
        manifest.workloads.api,
        tasks.api,
        cohort,
        baseValues,
      ),
      worker: resolveTaskEnvironment(
        'worker',
        manifest.workloads.worker,
        tasks.worker,
        cohort,
        baseValues,
      ),
    };
  }
  const selected = environments[runtimeCohort];
  if (selected === undefined)
    throw new Error(`no rendered environment for ${runtimeCohort}`);
  await startApi(
    tasks.api,
    selected.api,
    objectStoreBridge.caPath,
    runtimeCohort,
  );
  await startWorker(
    tasks.worker,
    selected.worker,
    objectStoreBridge.caPath,
    runtimeCohort,
  );

  process.stdout.write(
    `IWA02 rendered-task startup smoke passed: image=${resolvedImage.reference} imageId=${resolvedImage.imageId} imageDigestSource=${resolvedImage.source} renderedCohorts=${productionCohorts.join(',')} runtimeCohort=${runtimeCohort} database=${databaseName}.\n`,
  );
} finally {
  await Promise.all(
    [...containers].map(async (name) => {
      await docker(['rm', '--force', name]).catch(() => undefined);
    }),
  );
  await objectStoreBridge?.close();
  await telemetryServer?.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function render(directory) {
  await execFileAsync(process.execPath, [renderer, directory], {
    cwd: root,
    env: renderEnvironment,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function resolveImage(localImage) {
  const inspection = JSON.parse(
    // This is intentionally synchronous at module setup so the rendered image
    // URI is fixed before task definitions are produced.
    execFileSync('docker', ['image', 'inspect', localImage], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    }),
  )[0];
  const imageId = String(inspection?.Id ?? '').replace(/^sha256:/u, '');
  if (!/^[a-f0-9]{64}$/u.test(imageId))
    throw new Error(
      `IWA02_IMAGE does not have a sha256 image identity: ${localImage}`,
    );
  const repositoryDigest = (inspection.RepoDigests ?? []).find((entry) =>
    /@sha256:[a-f0-9]{64}$/u.test(entry),
  );
  const reference =
    repositoryDigest ?? `${imageRepository(localImage)}@sha256:${imageId}`;
  const resolved = JSON.parse(
    execFileSync('docker', ['image', 'inspect', reference], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    }),
  )[0];
  const resolvedImageId = String(resolved?.Id ?? '').replace(/^sha256:/u, '');
  if (resolvedImageId !== imageId)
    throw new Error(
      `IWA02_IMAGE digest does not resolve to the supplied local image: ${reference}`,
    );
  return Object.freeze({
    imageId,
    reference,
    source: repositoryDigest === undefined ? 'local-config' : 'repository',
  });
}

function imageRepository(localImage) {
  const digestSeparator = localImage.indexOf('@');
  const withoutDigest =
    digestSeparator === -1 ? localImage : localImage.slice(0, digestSeparator);
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > lastSlash
    ? withoutDigest.slice(0, lastColon)
    : withoutDigest;
}

function localFixtureValues(telemetryPort, objectStorePort) {
  const postgresPassword = {
    api: process.env.IWA02_POSTGRES_API_PASSWORD ?? 'pertexo-local-api',
    dispatcher:
      process.env.IWA02_POSTGRES_DISPATCHER_PASSWORD ??
      'pertexo-local-dispatcher',
    worker:
      process.env.IWA02_POSTGRES_WORKER_PASSWORD ?? 'pertexo-local-worker',
  };
  const postgresUrl = (user, password) =>
    `postgresql://${user}:${password}@${databaseHost}:${databasePort}/${databaseName}`;
  const redisPassword =
    process.env.IWA02_REDIS_PASSWORD ?? 'pertexo-local-redis';
  return {
    ARTIFACT_STORE_ACCESS_KEY_ID:
      process.env.IWA02_ARTIFACT_ACCESS_KEY_ID ?? 'pertexo-local-access-key',
    ARTIFACT_STORE_BUCKET:
      process.env.IWA02_ARTIFACT_BUCKET ?? 'pertexo-artifacts',
    ARTIFACT_STORE_ENDPOINT: `https://host.docker.internal:${objectStorePort}`,
    ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
    ARTIFACT_STORE_REGION: 'eu-central-1',
    ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID:
      process.env.IWA02_ARTIFACT_RECOVERY_ACCESS_KEY_ID ??
      'pertexo-local-recovery-access-key',
    ARTIFACT_STORE_RECOVERY_BUCKET:
      process.env.IWA02_ARTIFACT_RECOVERY_BUCKET ??
      'pertexo-artifacts-recovery',
    ARTIFACT_STORE_RECOVERY_ENDPOINT: `https://host.docker.internal:${objectStorePort}`,
    ARTIFACT_STORE_RECOVERY_FORCE_PATH_STYLE: 'true',
    ARTIFACT_STORE_RECOVERY_REGION: 'eu-west-1',
    ARTIFACT_STORE_SECRET_ACCESS_KEY:
      process.env.IWA02_ARTIFACT_SECRET_ACCESS_KEY ??
      'pertexo-local-secret-key',
    ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY:
      process.env.IWA02_ARTIFACT_RECOVERY_SECRET_ACCESS_KEY ??
      'pertexo-local-recovery-secret-key',
    CONNECTION_KMS_KEY_REFERENCE:
      process.env.IWA02_CONNECTION_KMS_KEY_REFERENCE ??
      'alias/pertexo-connections',
    CONNECTION_KMS_REGION: 'eu-central-1',
    DATABASE_API_URL: postgresUrl('pertexo_api', postgresPassword.api),
    DATABASE_DISPATCHER_URL: postgresUrl(
      'pertexo_dispatcher',
      postgresPassword.dispatcher,
    ),
    DATABASE_WORKER_URL: postgresUrl('pertexo_worker', postgresPassword.worker),
    OIDC_AUTHORIZATION_ENDPOINT:
      'https://identity.example.test/oauth2/authorize',
    OIDC_CLIENT_ID: 'pertexo-api',
    OIDC_CLIENT_SECRET: 'iwa02-local-oidc-client-secret',
    OIDC_ISSUER: 'https://identity.example.test',
    OIDC_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
    OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/oidc/callback',
    OIDC_TOKEN_ENDPOINT: 'https://identity.example.test/oauth2/token',
    OIDC_TRANSACTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    OIDC_TRANSACTION_KEY_VERSION: 'iwa02-local-v1',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://host.docker.internal:${telemetryPort}`,
    OUTBOX_DISPATCH_JOB_NAMES: activeQueueJobNames.join(','),
    REDIS_URL: `redis://:${redisPassword}@${redisHost}:${redisPort}/0`,
    SERVICE_VERSION:
      process.env.IWA02_SERVICE_VERSION ?? 'iwa02-rendered-local',
    TRUST_PROXY_CIDRS: '10.0.0.0/8, 2001:db8::/32',
  };
}

function resolveTaskEnvironment(workloadName, workload, task, cohort, values) {
  const container = task.containerDefinitions?.[0];
  if (container === undefined)
    throw new Error(`${workloadName} has no rendered container`);
  if (container.image !== renderEnvironment.ECS_IMAGE_URI)
    throw new Error(
      `${workloadName} does not retain the rendered immutable image`,
    );
  if (
    container.user !== '10001:10001' ||
    container.readonlyRootFilesystem !== true
  )
    throw new Error(
      `${workloadName} weakens the rendered user/filesystem boundary`,
    );
  if (container.linuxParameters?.initProcessEnabled !== true)
    throw new Error(`${workloadName} does not retain ECS init`);
  if (JSON.stringify(container.command) !== JSON.stringify(workload.command))
    throw new Error(
      `${workloadName} startup command differs from its manifest`,
    );

  const environment = Object.fromEntries(
    (container.environment ?? []).map(({ name, value }) => {
      if (typeof name !== 'string' || typeof value !== 'string')
        throw new Error(
          `${workloadName} has a non-scalar rendered environment value`,
        );
      return [name, value];
    }),
  );
  const injectedNames = (container.secrets ?? []).map(({ name, valueFrom }) => {
    if (typeof name !== 'string' || typeof valueFrom !== 'string')
      throw new Error(`${workloadName} has an invalid rendered injection`);
    if (
      !workload.configuration.includes(name) &&
      !workload.secrets.includes(name)
    )
      throw new Error(`${workloadName} renders undeclared injection ${name}`);
    const expectedPrefix = workload.configuration.includes(name)
      ? `${renderEnvironment.ECS_CONFIG_PREFIX_ARN}/${workloadName}/${name}`
      : `${renderEnvironment.ECS_SECRET_PREFIX_ARN}/${workloadName}/${name}`;
    if (valueFrom !== expectedPrefix)
      throw new Error(
        `${workloadName} injection ${name} has the wrong source reference`,
      );
    const value =
      values[name] ??
      (name === 'NODE_COMPATIBILITY_COHORT' ? cohort : undefined);
    if (value === undefined)
      throw new Error(`no local fixture value for ${workloadName}.${name}`);
    environment[name] = value;
    return name;
  });
  const expectedInjected = [
    ...workload.configuration,
    ...workload.secrets,
  ].toSorted();
  if (
    JSON.stringify([...injectedNames].toSorted()) !==
    JSON.stringify(expectedInjected)
  )
    throw new Error(
      `${workloadName} rendered injection set differs from its manifest`,
    );
  return environment;
}

async function assertRoleConfigurationNegative(environment, caPath) {
  const invalid = { ...environment };
  delete invalid.CONNECTION_KMS_REGION;
  const args = dockerTaskArguments(
    'iwa02-rendered-negative',
    invalid,
    caPath,
    ['--rm', '--entrypoint', 'node'],
    false,
  );
  args.push(
    resolvedImage.reference,
    '--input-type=module',
    '--eval',
    "const { parseApiConfig } = await import('./apps/api/dist/platform/config/api-config.js'); parseApiConfig(process.env);",
  );
  try {
    await execFileAsync('docker', args, {
      cwd: root,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr)
        : '';
    if (!stderr.includes('Connection KMS configuration is incomplete'))
      throw new Error(
        'rendered API negative did not preserve the KMS configuration failure',
        { cause: error },
      );
    return;
  }
  throw new Error(
    'rendered API accepted a task environment missing CONNECTION_KMS_REGION',
  );
}

async function startApi(task, environment, caPath, cohort) {
  const name = `iwa02-rendered-api-${cohort}`;
  const args = dockerTaskArguments(name, environment, caPath, [
    '--publish',
    '127.0.0.1::3000',
  ]);
  args.push(resolvedImage.reference, ...task.containerDefinitions[0].command);
  const { stdout } = await execFileAsync('docker', args, { cwd: root });
  containers.add(name);
  const portOutput = await docker(['port', name, '3000/tcp']);
  const match = /:(\d+)\s*$/u.exec(portOutput.stdout.trim());
  if (match === null)
    throw new Error(`could not resolve mapped API port for ${cohort}`);
  const port = Number(match[1]);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await containerState(name);
    if (!state.running)
      throw new Error(
        `rendered API exited during ${cohort} startup (exitCode=${String(state.exitCode)})`,
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (
        response.status === 200 &&
        (await response.text()) === '{"status":"ready"}'
      ) {
        process.stdout.write(
          `IWA02 API ready: cohort=${cohort} container=${stdout.trim().slice(0, 12)} port=${port}.\n`,
        );
        return;
      }
    } catch {
      // The listener is not available until Nest bootstrap completes.
    }
    await delay(250);
  }
  throw new Error(`rendered API did not become ready for ${cohort}`);
}

async function startWorker(task, environment, caPath, cohort) {
  const name = `iwa02-rendered-worker-${cohort}`;
  const args = dockerTaskArguments(name, environment, caPath, []);
  args.push(resolvedImage.reference, ...task.containerDefinitions[0].command);
  const { stdout } = await execFileAsync('docker', args, { cwd: root });
  containers.add(name);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await containerState(name);
    if (!state.running)
      throw new Error(
        `rendered worker exited during ${cohort} startup (exitCode=${String(state.exitCode)})`,
      );
    const marker = await execFileAsync(
      'docker',
      ['exec', name, 'test', '-f', '/tmp/pertexo-worker-ready'],
      { cwd: root, maxBuffer: 64 * 1024 },
    )
      .then(() => true)
      .catch(() => false);
    const logs = await containerLogs(name);
    if (marker && logs.includes('worker.started')) {
      process.stdout.write(
        `IWA02 worker ready: cohort=${cohort} container=${stdout.trim().slice(0, 12)}.\n`,
      );
      return;
    }
    await delay(250);
  }
  throw new Error(`rendered worker did not become ready for ${cohort}`);
}

function dockerTaskArguments(
  name,
  environment,
  caPath,
  extra,
  detached = true,
) {
  const args = [
    'run',
    ...(detached ? ['--detach'] : []),
    '--name',
    name,
    '--init',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--user',
    '10001:10001',
    '--add-host',
    'host.docker.internal:host-gateway',
    '--volume',
    `${caPath}:/tmp/iwa02-local-ca.pem:ro`,
    '--env',
    'NODE_EXTRA_CA_CERTS=/tmp/iwa02-local-ca.pem',
    ...extra,
  ];
  for (const [name, value] of Object.entries(environment)) {
    if (value.includes('\n') || value.includes('\0'))
      throw new Error(`environment value for ${name} is not a Docker scalar`);
    args.push('--env', `${name}=${value}`);
  }
  return args;
}

async function containerState(name) {
  const result = await docker([
    'inspect',
    '--format',
    '{{.State.Running}}|{{.State.ExitCode}}',
    name,
  ]);
  const [running, exitCode] = result.stdout.trim().split('|');
  return { running: running === 'true', exitCode: Number(exitCode) };
}

async function containerLogs(name) {
  return docker(['logs', '--tail', '100', name])
    .then((result) => `${result.stdout}${result.stderr ?? ''}`.slice(-8_000))
    .catch(() => '');
}

async function docker(args) {
  return execFileAsync('docker', args, {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function createTelemetryServer() {
  const server = createHttpServer((request, response) => {
    request.resume();
    response.statusCode = 200;
    response.end();
  });
  await listen(server);
  return { port: server.address().port, close: () => closeServer(server) };
}

async function createObjectStoreBridge() {
  const directory = await mkdtemp(resolve(tmpdir(), 'pertexo-iwa02-tls-'));
  const keyPath = resolve(directory, 'local.key');
  const caPath = resolve(directory, 'local-ca.pem');
  await execFileAsync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=host.docker.internal',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign,digitalSignature',
      '-addext',
      'subjectAltName=DNS:host.docker.internal',
      '-keyout',
      keyPath,
      '-out',
      caPath,
    ],
    { cwd: root, maxBuffer: 1 * 1024 * 1024 },
  );
  const server = createHttpsServer(
    { key: await readFile(keyPath), cert: await readFile(caPath) },
    (request, response) => {
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: artifactStorePort,
          method: request.method,
          path: request.url,
          headers: {
            ...request.headers,
            host: `127.0.0.1:${artifactStorePort}`,
          },
        },
        (upstreamResponse) => {
          if (request.url?.includes('?location') !== true) {
            response.writeHead(
              upstreamResponse.statusCode ?? 502,
              upstreamResponse.headers,
            );
            upstreamResponse.pipe(response);
            return;
          }

          const chunks = [];
          upstreamResponse.on('data', (chunk) => chunks.push(chunk));
          upstreamResponse.on('end', () => {
            const bucket = request.url
              ?.split('?')[0]
              .split('/')
              .filter(Boolean)[0];
            const region =
              bucket === 'pertexo-artifacts-recovery'
                ? 'eu-west-1'
                : 'eu-central-1';
            const body = Buffer.concat(chunks)
              .toString('utf8')
              .replace(
                /(<LocationConstraint(?:\s[^>]*)?>)(?:null|us-east-1)(<\/LocationConstraint>)/u,
                `$1${region}$2`,
              );
            const headers = { ...upstreamResponse.headers };
            delete headers['content-length'];
            delete headers['transfer-encoding'];
            headers['content-length'] = Buffer.byteLength(body);
            response.writeHead(upstreamResponse.statusCode ?? 502, headers);
            response.end(body);
          });
        },
      );
      upstream.on('error', (error) => {
        process.stderr.write(
          `IWA02 local object-store bridge upstream request failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.on('error', () => upstream.destroy());
      request.pipe(upstream);
    },
  );
  server.on('tlsClientError', (error) => {
    process.stderr.write(
      `IWA02 local object-store bridge TLS request failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
  await listen(server);
  return {
    caPath,
    port: server.address().port,
    close: async () => {
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolvePromise);
  });
}

async function closeServer(server) {
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error(`${name} must be a valid TCP port`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}
