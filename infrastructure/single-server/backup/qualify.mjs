import { seedSharingRecoveryFixture } from './sharing.fixture.mjs';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { copyObjectTree } from './copy-objects.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRecoveryFiles } from './files.fixture.mjs';
import { seedEncryptedRecoveryFixture } from './encryption.fixture.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { parseEnv } from 'node:util';
import { createArtifactStore } from '../../../packages/artifact-store/dist/store.js';
import { parseArtifactStoreConfig } from '../../../packages/artifact-store/dist/config/index.js';

const directory = mkdtempSync(join(tmpdir(), 'pertexo-recovery-'));
const network = `pertexo-recovery-${randomUUID()}`;
const containers = [];
const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
const rust =
  'rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c';
const rc =
  'rustfs/rc:v0.1.36@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699';
const clone =
  'rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5';
const postgres =
  'postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280';
let networkCreated = false;
let store;
const clients = [];
const databaseEnvironments = new Map();
let failure;
function create(args) {
  const id = docker(['create', ...args]).trim();
  containers.push(id);
  docker(['start', id]);
  return id;
}
async function waitFor(check) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
function secrets() {
  return parseEnv(
    execFileSync(
      process.execPath,
      ['infrastructure/single-server/generate-secrets.mjs', '--encryption=kms'],
      { encoding: 'utf8' },
    ),
  );
}
async function storage(alias, bucket) {
  const secret = secrets();
  const env = {
    ...secret,
    NODE_ENV: 'production',
    ARTIFACT_SCRATCH_DIRECTORY: '/var/lib/pertexo/artifact-scratch',
    AUTH_MAIL_MODE: 'durable',
    SESSION_COOKIE_SECURE: 'true',
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    AUTH_MAIL_FROM: 'security@example.test',
    AUTH_MAIL_EMAIL_API_KEY: 'fixture-mail',
    INVITATION_EMAIL_FROM: 'invites@example.test',
    INVITATION_EMAIL_API_KEY: 'fixture-mail',
    CONNECTION_KMS_KEY_REFERENCE: 'alias/fixture',
    CONNECTION_KMS_REGION: 'eu-central-1',
    TRUST_PROXY_CIDRS: '172.30.42.0/24',
    ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
    ARTIFACT_STORE_REGION: 'us-east-1',
    ARTIFACT_STORE_BUCKET: bucket,
    ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
  };
  const prepared = join(directory, alias);
  execFileSync('mkdir', ['-p', prepared]);
  execFileSync(
    process.execPath,
    ['infrastructure/single-server/storage/prepare.mjs', prepared],
    { env },
  );
  const rcEnv = readFileSync(join(prepared, 'rc.env'), 'utf8').replace(
    'storage:9000',
    `${alias}:9000`,
  );
  writeFileSync(join(prepared, 'rc.env'), rcEnv);
  const id = create([
    '--network',
    network,
    '--network-alias',
    alias,
    '-p',
    '127.0.0.1::9000',
    '-e',
    `RUSTFS_ACCESS_KEY=${secret.STORAGE_ADMIN_ACCESS_KEY_ID}`,
    '-e',
    `RUSTFS_SECRET_KEY=${secret.STORAGE_ADMIN_SECRET_ACCESS_KEY}`,
    '-e',
    'RUSTFS_CONSOLE_ENABLE=false',
    '-e',
    'RUSTFS_REGION=us-east-1',
    rust,
    '/data',
  ]);
  const port = docker(['port', id, '9000/tcp']).trim().split(':').at(-1);
  const endpoint = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    const r = await fetch(`${endpoint}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    await r.arrayBuffer();
    assert.ok(r.ok);
  });
  docker([
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
    join(prepared, 'rc.env'),
    '-v',
    `${prepared}:/prepared:ro`,
    '-v',
    `${resolve('infrastructure/single-server/storage/bootstrap.sh')}:/bootstrap.sh:ro`,
    '--entrypoint',
    '/bin/sh',
    rc,
    '/bootstrap.sh',
  ]);
  return { ...env, ARTIFACT_STORE_ENDPOINT: endpoint };
}
async function database(alias, migrate) {
  const secret = secrets();
  const environment = {
    POSTGRES_DB: 'pertexo',
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: secret.POSTGRES_SUPERUSER_PASSWORD,
    POSTGRES_OWNER_USER: 'pertexo_owner',
    POSTGRES_MIGRATION_USER: 'pertexo_migration',
    POSTGRES_MIGRATION_PASSWORD: secret.POSTGRES_MIGRATION_PASSWORD,
    POSTGRES_APP_USER: 'pertexo_app',
    POSTGRES_APP_PASSWORD: secret.POSTGRES_APP_PASSWORD,
    POSTGRES_MAINTENANCE_USER: 'pertexo_maintenance',
    POSTGRES_MAINTENANCE_PASSWORD: secret.POSTGRES_MAINTENANCE_PASSWORD,
  };
  const id = create([
    '--network',
    network,
    '--network-alias',
    alias,
    '-p',
    '127.0.0.1::5432',
    ...Object.entries(environment).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ]),
    '-v',
    `${resolve('infrastructure/postgres/init')}:/docker-entrypoint-initdb.d:ro`,
    postgres,
    'postgres',
    '-c',
    'shared_preload_libraries=pg_stat_statements',
  ]);
  await waitFor(() =>
    docker([
      'exec',
      id,
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-d',
      'pertexo',
    ]),
  );
  const port = docker(['port', id, '5432/tcp']).trim().split(':').at(-1);
  databaseEnvironments.set(id, {
    DATABASE_URL:
      'postgresql://pertexo_app:' +
      secret.POSTGRES_APP_PASSWORD +
      '@127.0.0.1:' +
      port +
      '/pertexo',
    DATABASE_MAINTENANCE_URL:
      'postgresql://pertexo_maintenance:' +
      secret.POSTGRES_MAINTENANCE_PASSWORD +
      '@127.0.0.1:' +
      port +
      '/pertexo',
  });
  if (migrate)
    await waitFor(() =>
      execFileSync(process.execPath, ['packages/database/dist/migrate.js'], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_MIGRATION_URL: `postgresql://pertexo_migration:${secret.POSTGRES_MIGRATION_PASSWORD}@127.0.0.1:${port}/pertexo`,
        },
        stdio: 'pipe',
        timeout: 10000,
      }),
    );
  return id;
}
function sql(id, input) {
  return docker(
    [
      'exec',
      '-i',
      id,
      'psql',
      '-U',
      'postgres',
      '-d',
      'pertexo',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input },
  );
}
try {
  for (const image of [rust, rc, clone, postgres]) docker(['pull', image]);
  docker(['network', 'create', network]);
  networkCreated = true;
  const source = await storage('storage', 'pertexo-artifacts');
  const backup = await storage('destination', 'pertexo-backups');
  const sourceDb = await database('source-db', true);
  const targetDb = await database('target-db', false);
  const encryption = await seedEncryptedRecoveryFixture(sql, sourceDb);
  const sharing = seedSharingRecoveryFixture(sql, sourceDb);
  const { artifacts, bodies, bundle } = createRecoveryFiles();
  store = createArtifactStore(parseArtifactStoreConfig(source));
  for (const artifact of artifacts)
    await store.put({
      ...artifact,
      body: Readable.from([bodies.get(artifact.artifactId)]),
    });
  sql(
    sourceDb,
    `SET ROLE pertexo_owner;
 CREATE TABLE public.recovery_fixture(workspace_id uuid, artifact_id uuid, sha256 text, pages_json jsonb);
 ALTER TABLE public.recovery_fixture ENABLE ROW LEVEL SECURITY;
 ALTER TABLE public.recovery_fixture FORCE ROW LEVEL SECURITY;
 CREATE POLICY workspace_only ON public.recovery_fixture USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
 GRANT SELECT ON public.recovery_fixture TO pertexo_app;
 RESET ROLE;
 INSERT INTO public.recovery_fixture VALUES ${artifacts.map((a) => `('${a.workspaceId}','${a.artifactId}','${a.sha256}',${a.artifactId === bundle.pages[0].artifactId ? "'" + JSON.stringify(bundle) + "'::jsonb" : 'NULL'})`).join(',')};`,
  );
  const dump = docker(
    [
      'exec',
      sourceDb,
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      'pertexo',
      '--format=custom',
    ],
    { encoding: null },
  );
  writeFileSync(join(directory, 'database.dump'), dump);
  const env = { RCLONE_CONFIG: '/dev/null' };
  for (const [remote, config, endpoint] of [
    ['SOURCE', source, 'http://storage:9000'],
    ['BACKUP', backup, 'http://destination:9000'],
  ]) {
    Object.assign(
      env,
      Object.fromEntries(
        Object.entries({
          TYPE: 's3',
          PROVIDER: 'Other',
          ENV_AUTH: 'false',
          ACCESS_KEY_ID: config.ARTIFACT_STORE_ACCESS_KEY_ID,
          SECRET_ACCESS_KEY: config.ARTIFACT_STORE_SECRET_ACCESS_KEY,
          REGION: 'us-east-1',
          ENDPOINT: endpoint,
          FORCE_PATH_STYLE: 'true',
          NO_CHECK_BUCKET: 'true',
        }).map(([field, value]) => [`RCLONE_CONFIG_${remote}_${field}`, value]),
      ),
    );
  }
  const envFile = join(directory, 'rclone.env');
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
    { mode: 0o600 },
  );
  const rclone = (args) =>
    docker([
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
      envFile,
      '-v',
      `${directory}:/backup`,
      clone,
      ...args,
    ]);
  clients.push(
    ...[source, backup].map(
      (config) =>
        new S3Client({
          endpoint: config.ARTIFACT_STORE_ENDPOINT,
          region: 'us-east-1',
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.ARTIFACT_STORE_ACCESS_KEY_ID,
            secretAccessKey: config.ARTIFACT_STORE_SECRET_ACCESS_KEY,
          },
        }),
    ),
  );
  const original = {
    client: clients[0],
    bucket: 'pertexo-artifacts',
    prefix: '',
  };
  const saved = {
    client: clients[1],
    bucket: 'pertexo-backups',
    prefix: 'pertexo-beta/20261013T030000Z/objects/',
  };
  const point = 'backup:pertexo-backups/pertexo-beta/20261013T030000Z';
  const fixedFiles = [
    'database.dump',
    'release.txt',
    'objects.count',
    'SHA256SUMS',
    'COMPLETE',
  ];
  writeFileSync(
    join(directory, 'release.txt'),
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
  );
  writeFileSync(
    join(directory, 'objects.count'),
    String(artifacts.length) + '\n',
  );
  const checksums = ['database.dump', 'release.txt', 'objects.count']
    .map(
      (file) =>
        createHash('sha256')
          .update(readFileSync(join(directory, file)))
          .digest('hex') +
        '  ' +
        file +
        '\n',
    )
    .join('');
  writeFileSync(join(directory, 'SHA256SUMS'), checksums);
  for (const file of fixedFiles.filter((file) => file !== 'COMPLETE'))
    rclone(['copyto', '/backup/' + file, point + '/' + file]);
  assert.equal(await copyObjectTree(saved, original), 0);
  assert.equal(await copyObjectTree(original, saved), artifacts.length);
  rclone([
    'check',
    '--download',
    'source:pertexo-artifacts',
    `${point}/objects`,
  ]);
  writeFileSync(join(directory, 'COMPLETE'), 'complete\n');
  rclone(['copyto', '/backup/COMPLETE', point + '/COMPLETE']);
  const files = rclone(['lsf', '--recursive', '--files-only', point])
    .trim()
    .split('\n');
  assert.deepEqual(
    files.filter((file) => !file.startsWith('objects/')).sort(),
    fixedFiles.sort(),
  );
  assert.equal(
    files.filter((file) => file.startsWith('objects/')).length,
    artifacts.length,
  );
  rclone(['copyto', point + '/database.dump', '/backup/restored.dump']);
  const restoredDump = readFileSync(join(directory, 'restored.dump'));
  assert.deepEqual(restoredDump, dump);
  for (const key of encryption.masterKeys) {
    assert.ok(!restoredDump.includes(Buffer.from(key)));
    assert.ok(!restoredDump.includes(Buffer.from(key, 'base64')));
  }
  for (const artifact of artifacts) {
    let completed = false;
    for (let page = 0; page < 5 && !completed; page++)
      completed = (
        await store.purgeWorkspacePage({
          workspaceId: artifact.workspaceId,
          maxObjects: 500,
        })
      ).completed;
    assert.ok(completed);
  }
  assert.equal(await copyObjectTree(saved, original), artifacts.length);
  for (const client of clients) client.destroy();
  for (const artifact of artifacts) {
    assert.deepEqual(await store.head(artifact), artifact);
    const download = await store.getStream(artifact);
    const chunks = [];
    for await (const chunk of download.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bodies.get(artifact.artifactId));
  }
  const restoredTargets = [
    targetDb,
    await database('missing-key-db', false),
    await database('wrong-key-db', false),
    await database('webhook-only-db', false),
  ];
  // Each target starts with bootstrap roles only, and receives the same matched point.
  for (const target of restoredTargets)
    docker(
      [
        'exec',
        '-i',
        target,
        'pg_restore',
        '-U',
        'postgres',
        '-d',
        'pertexo',
        '--clean',
        '--if-exists',
        '--single-transaction',
        '--exit-on-error',
      ],
      { input: restoredDump },
    );
  assert.equal(
    sql(targetDb, 'SELECT count(*) FROM public.recovery_fixture;').trim(),
    String(artifacts.length),
  );
  assert.deepEqual(
    JSON.parse(
      sql(
        targetDb,
        'SELECT pages_json FROM public.recovery_fixture WHERE pages_json IS NOT NULL LIMIT 1;',
      ).trim(),
    ),
    bundle,
  );
  sharing.verify(targetDb);
  const visible = sql(
    targetDb,
    `SET ROLE pertexo_app; SELECT set_config('app.workspace_id','${artifacts[0].workspaceId}',false); SELECT count(*) FROM public.recovery_fixture;`,
  );
  assert.equal(visible.trim().split('\n').at(-1), '1');
  const foreignPages = sql(
    targetDb,
    `SET ROLE pertexo_app; SELECT set_config('app.workspace_id','${artifacts[0].workspaceId}',false); SELECT count(*) FROM public.recovery_fixture WHERE pages_json IS NOT NULL;`,
  );
  assert.equal(foreignPages.trim().split('\n').at(-1), '0');
  assert.equal(
    sql(
      targetDb,
      "SELECT relforcerowsecurity FROM pg_class WHERE oid='public.recovery_fixture'::regclass;",
    ).trim(),
    't',
  );
  const preflight = (target, configuration, status = 0) => {
    const result = spawnSync(
      process.execPath,
      ['infrastructure/single-server/encryption/verify.mjs'],
      {
        env: { ...configuration, ...databaseEnvironments.get(target) },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(result.status, status, result.stderr);
    for (const key of encryption.masterKeys)
      assert.ok(!result.stderr.includes(key));
    return JSON.parse(status === 0 ? result.stdout : result.stderr);
  };
  assert.deepEqual(preflight(targetDb, encryption.environment), {
    event: 'encryption.verified',
    mode: 'self-managed',
    connectionKeys: 2,
    webhookKeys: 2,
  });
  await encryption.openRestored(targetDb);
  for (const configuration of encryption.callbackUnavailable) {
    const failure = preflight(targetDb, configuration, 1);
    assert.equal(failure.code, 'callback_key_unavailable');
    assert.match(failure.detail, /CALLBACK_TOKEN_PREVIOUS_KEYS/u);
  }
  console.log(
    'Callback recovery: both hash/key versions restored; wrong and missing callback keys refused; no callback keys in recovery files',
  );
  for (const [index, configuration] of encryption.unavailable.entries()) {
    const failure = preflight(restoredTargets[index + 1], configuration, 1);
    assert.equal(failure.code, 'unavailable_key_material');
    assert.match(failure.detail, /current and previous master keys/u);
  }
  const kms = {
    NODE_ENV: 'production',
    CONNECTION_ENCRYPTION_MODE: 'kms',
    CONNECTION_KMS_KEY_REFERENCE: 'alias/fixture',
    CONNECTION_KMS_REGION: 'eu-central-1',
  };
  assert.equal(preflight(targetDb, kms, 1).code, 'incompatible_provider');
  encryption.keepWebhooksOnly(restoredTargets[3]);
  assert.deepEqual(preflight(restoredTargets[3], encryption.environment), {
    event: 'encryption.verified',
    mode: 'self-managed',
    connectionKeys: 0,
    webhookKeys: 2,
  });
  assert.equal(
    preflight(restoredTargets[3], encryption.unavailable[0], 1).code,
    'unavailable_key_material',
  );
  console.log(
    'Encrypted recovery: both key versions opened, wrong/missing keys and provider switches refused, webhook-only verification passed; no master keys in recovery files',
  );
  console.log(
    'Real recovery: repository schema, all RLS rows, ownership/grants, artifact bytes/metadata passed',
  );
} catch (error) {
  failure = error;
} finally {
  store?.close();
  for (const client of clients) client.destroy();
  const results = await Promise.allSettled(
    containers.map(async (id) => docker(['rm', '-fv', id])),
  );
  if (networkCreated)
    results.push(
      ...(await Promise.allSettled([
        Promise.resolve().then(() => docker(['network', 'rm', network])),
      ])),
    );
  rmSync(directory, { recursive: true, force: true });
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...failures],
      'Recovery fixture or cleanup failed',
    );
}
if (failure) throw failure;
