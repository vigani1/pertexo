import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parseEnv } from 'node:util';
import { createArtifactStore } from '../../../packages/artifact-store/dist/store.js';
import { parseArtifactStoreConfig } from '../../../packages/artifact-store/dist/config/index.js';

const image =
  'rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c';
const directory = await mkdtemp(join(tmpdir(), 'pertexo-storage-'));
const name = `pertexo-storage-${randomUUID()}`;
const network = `${name}-network`;
let networkCreated = false;
const docker = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
let started = false;
let store;
try {
  const bucket = 'pertexo-artifacts';
  const generated = parseEnv(
    execFileSync(
      process.execPath,
      ['infrastructure/single-server/generate-secrets.mjs', '--encryption=kms'],
      { encoding: 'utf8' },
    ),
  );
  const environment = {
    ...generated,
    NODE_ENV: 'production',
    ARTIFACT_SCRATCH_DIRECTORY: '/var/lib/pertexo/artifact-scratch',
    AUTH_MAIL_MODE: 'durable',
    SESSION_COOKIE_SECURE: 'true',
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    AUTH_MAIL_FROM: 'security@example.test',
    AUTH_MAIL_EMAIL_API_KEY: 'fixture-provider',
    INVITATION_EMAIL_API_KEY: 'fixture-provider',
    INVITATION_EMAIL_FROM: 'invites@example.test',
    CONNECTION_KMS_KEY_REFERENCE: 'alias/fixture',
    CONNECTION_KMS_REGION: 'eu-central-1',
    TRUST_PROXY_CIDRS: '172.30.42.0/24',
    ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
    ARTIFACT_STORE_REGION: 'us-east-1',
    ARTIFACT_STORE_BUCKET: bucket,
    ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
  };
  execFileSync(
    process.execPath,
    ['infrastructure/single-server/storage/prepare.mjs', directory],
    { env: environment, stdio: 'pipe' },
  );
  docker(['pull', image]);
  const clientImage =
    'rustfs/rc:v0.1.36@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699';
  docker(['pull', clientImage]);
  docker(['network', 'create', network]);
  networkCreated = true;
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    '--network-alias',
    'storage',
    '-p',
    '127.0.0.1::9000',
    '-e',
    `RUSTFS_ACCESS_KEY=${environment.STORAGE_ADMIN_ACCESS_KEY_ID}`,
    '-e',
    `RUSTFS_SECRET_KEY=${environment.STORAGE_ADMIN_SECRET_ACCESS_KEY}`,
    '-e',
    'RUSTFS_CONSOLE_ENABLE=false',
    '-e',
    'RUSTFS_REGION=us-east-1',
    '-e',
    'RUSTFS_CORS_ALLOWED_ORIGINS=https://app.example.test',
    image,
    '/data',
  ]);
  started = true;
  const port = docker(['port', name, '9000/tcp']).trim().split(':').at(-1);
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const ready = await fetch(`${endpoint}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      await ready.arrayBuffer();
      if (ready.ok) break;
    } catch {
      /* A new storage process may not be listening yet. */
    }
    if (Date.now() >= deadline) throw new Error('Storage readiness timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const { resolve } = await import('node:path');
  const bootstrap = [
    'run',
    '--rm',
    '--network',
    network,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--env-file',
    join(directory, 'rc.env'),
    '-v',
    `${directory}:/prepared:ro`,
    '-v',
    `${resolve('infrastructure/single-server/storage/bootstrap.sh')}:/bootstrap.sh:ro`,
    '--entrypoint',
    '/bin/sh',
    clientImage,
    '/bootstrap.sh',
  ];
  docker(bootstrap);
  docker(bootstrap); // Reapplying setup must preserve an existing bucket and identity.
  Object.assign(environment, {
    ...process.env,
    ...environment,
    ARTIFACT_STORE_ENDPOINT: endpoint,
    ARTIFACT_STORE_INTEGRATION: 'true',
  });
  store = createArtifactStore(parseArtifactStoreConfig(environment));
  await store.checkReadiness();
  docker([
    ...bootstrap.slice(0, -1),
    '-c',
    'rc bucket create --quiet internal/qualification-denied >/dev/null',
  ]);
  const deniedStore = createArtifactStore(
    parseArtifactStoreConfig({
      ...environment,
      ARTIFACT_STORE_BUCKET: 'qualification-denied',
    }),
  );
  try {
    await assert.rejects(deniedStore.checkReadiness());
  } finally {
    deniedStore.close();
  }
  execFileSync(
    'pnpm',
    ['--filter', '@pertexo/artifact-store', 'test:integration'],
    { env: environment, stdio: 'inherit', timeout: 60_000 },
  );
  for (const origin of [
    'https://app.example.test',
    'https://other.example.test',
  ]) {
    const response = await fetch(
      `${environment.ARTIFACT_STORE_ENDPOINT}/${bucket}/fixture`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers':
            'content-type,if-none-match,x-amz-checksum-sha256,x-amz-meta-workspace-id',
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      origin.includes('app.') ? origin : null,
    );
    await response.arrayBuffer();
  }
  const body = Buffer.from('workspace purge fixture');
  const workspaceId = randomUUID();
  const otherId = randomUUID();
  const artifacts = [workspaceId, workspaceId, otherId].map((workspaceId) => ({
    workspaceId,
    artifactId: randomUUID(),
    byteLength: body.length,
    mediaType: 'text/plain',
    sha256: createHash('sha256').update(body).digest('hex'),
  }));
  const anonymous = await fetch(
    `${endpoint}/${bucket}/workspaces/${workspaceId}/artifacts/${artifacts[0].artifactId}`,
    { signal: AbortSignal.timeout(5000) },
  );
  assert.equal(anonymous.status, 403);
  await anonymous.arrayBuffer();
  for (const artifact of artifacts)
    await store.put({ ...artifact, body: Readable.from([body]) });
  let completed = false;
  for (let page = 0; page < 5 && !completed; page++)
    completed = (await store.purgeWorkspacePage({ workspaceId, maxObjects: 1 }))
      .completed;
  assert.ok(completed);
  assert.equal(await store.head(artifacts[0]), null);
  assert.equal(await store.head(artifacts[1]), null);
  assert.deepEqual(await store.head(artifacts[2]), artifacts[2]);
  await store.delete(artifacts[2]);
  let markerCompleted = false;
  for (let page = 0; page < 5 && !markerCompleted; page++)
    markerCompleted = (
      await store.purgeWorkspacePage({ workspaceId: otherId, maxObjects: 1 })
    ).completed;
  assert.ok(markerCompleted);
  const bad = { ...artifacts[0], artifactId: randomUUID() };
  const upload = await store.beginDirectUpload({
    ...bad,
    expiresInSeconds: 60,
  });
  const corrupted = Buffer.alloc(body.length, 0);
  const rejected = await fetch(upload.url, {
    method: 'PUT',
    headers: upload.headers,
    body: corrupted,
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(rejected.status, 400);
  await rejected.arrayBuffer();
  console.log(
    'Pinned storage: adapter, metadata, conditional PUT, checksums, presigning, CORS and workspace purge passed',
  );
} finally {
  store?.close();
  if (started) docker(['rm', '-fv', name]);
  if (networkCreated) docker(['network', 'rm', network]);
  await rm(directory, { recursive: true, force: true });
}
