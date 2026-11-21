import { codeContainerLimits } from '../../../packages/node-sdk/dist/index.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { parseApiConfig } from '../../../apps/api/dist/platform/config/api-config.js';
import { parseWorkerConfig } from '../../../apps/worker/dist/config/worker.js';

test('both public hosts keep browsers on HTTPS', () => {
  const caddyfile = readFileSync(
    'infrastructure/single-server/Caddyfile',
    'utf8',
  );
  for (const host of ['{$APP_HOST}', '{$FILES_HOST}'])
    assert.match(
      caddyfile.slice(caddyfile.indexOf(`${host} {`)),
      /^\S+ \{\n\timport https_only\n/u,
    );
  assert.match(caddyfile, /Strict-Transport-Security "max-age=31536000"/u);
});

for (const { mode, transport } of ['kms', 'self-managed'].flatMap((mode) =>
  ['resend', 'smtp'].map((transport) => ({ mode, transport })),
))
  test(`resolved Compose isolates credentials for ${mode} and ${transport}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'pertexo-compose-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // The runbook's optional collector, set in half the cases: both servers must see it.
    const collector =
      transport === 'smtp' ? 'http://collector.example.test:4318' : undefined;
    const generated = parseEnv(
      execFileSync(
        process.execPath,
        [
          'infrastructure/single-server/generate-secrets.mjs',
          '--encryption=' + mode,
        ],
        { encoding: 'utf8' },
      ),
    );
    const environment = {
      ...process.env,
      ...parseEnv(
        readFileSync(
          'infrastructure/single-server/.env.production.example',
          'utf8',
        ),
      ),
      ...generated,
      PUBLIC_WEB_ORIGIN: 'https://app.example.test',
      ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
      AUTH_MAIL_FROM: 'security@example.test',
      AUTH_GOOGLE_CLIENT_ID: 'fixture-google-client',
      AUTH_GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
      AUTH_GITHUB_CLIENT_ID: 'fixture-github-client',
      AUTH_GITHUB_CLIENT_SECRET: 'fixture-github-secret',
      SYSTEM_MAIL_TRANSPORT: transport,
      ...(collector === undefined
        ? {}
        : { OTEL_EXPORTER_OTLP_ENDPOINT: collector }),
      ...(transport === 'smtp'
        ? {
            SYSTEM_MAIL_SMTP_HOST: 'smtp.example.test',
            SYSTEM_MAIL_SMTP_TLS: 'starttls',
            SYSTEM_MAIL_SMTP_USER: 'fixture-smtp-user',
            SYSTEM_MAIL_SMTP_PASSWORD: 'fixture-smtp-password',
          }
        : {
            AUTH_MAIL_EMAIL_API_KEY: 'fixture-mail',
            INVITATION_EMAIL_API_KEY: 'fixture-mail',
          }),
      INVITATION_EMAIL_FROM: 'invites@example.test',
      ...(mode === 'kms'
        ? {
            CONNECTION_KMS_KEY_REFERENCE: 'alias/fixture',
            CONNECTION_KMS_REGION: 'eu-central-1',
            AWS_ACCESS_KEY_ID: 'fixture-kms',
            AWS_SECRET_ACCESS_KEY: 'fixture-kms-secret',
          }
        : {
            CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: JSON.stringify([
              { version: '0', key: Buffer.alloc(32, 7).toString('base64') },
            ]),
          }),
      POSTGRES_SHARED_BUFFERS: mode === 'kms' ? '' : '256MB',
      // One mode keeps the defaults; the other gives a bigger server's memory.
      ...(mode === 'kms'
        ? {}
        : { API_MEMORY_MB: '1024', WORKER_MEMORY_MB: '2048' }),
      SERVICE_VERSION: 'b'.repeat(40),
      BETA_STATE_DIR: directory,
    };
    if (mode === 'kms') {
      delete environment.CODE_RUNNER_MEMORY_MB;
      delete environment.CODE_RUNNER_CONCURRENCY;
    }
    const resolved = join(directory, 'resolved.json');
    const compose = [
      'compose',
      '--env-file',
      '/dev/null',
      '-f',
      'infrastructure/single-server/compose.yaml',
      '--profile',
      'ops',
      'config',
      '--format',
      'json',
    ];
    writeFileSync(
      resolved,
      execFileSync('docker', [...compose, '--no-env-resolution'], {
        env: {
          ...environment,
          APP_HOST: 'app.example.test',
          FILES_HOST: 'files.example.test',
          CODE_RUNNER_CONTAINER_MEMORY_MB: '128',
          CODE_RUNNER_CONTAINER_CPUS: '1',
          CODE_RUNNER_CONTAINER_PIDS: '128',
          CODE_RUNNER_MANAGER_HEAP_MB: '32',
          API_CONTAINER_MEMORY_MB: '512',
          API_HEAP_MB: '256',
          WORKER_CONTAINER_MEMORY_MB: '768',
          WORKER_HEAP_MB: '256',
          WORKER_MAX_RSS_BYTES: '671088640',
        },
      }),
    );
    execFileSync(
      process.execPath,
      ['infrastructure/single-server/storage/prepare.mjs', directory],
      { env: { ...environment, PERTEXO_RESOLVED_CONFIG: resolved } },
    );
    const hosts = parseEnv(readFileSync(join(directory, 'hosts.env'), 'utf8'));
    const config = JSON.parse(
      execFileSync('docker', compose, {
        env: { ...environment, ...hosts },
        encoding: 'utf8',
      }),
    );
    assert.ok(
      config.services.postgres.command.includes(
        `shared_buffers=${mode === 'kms' ? '128MB' : '256MB'}`,
      ),
    );
    assert.equal(
      config.services.postgres.volumes.find(
        (v) => v.target === '/docker-entrypoint-initdb.d',
      ).source,
      join(directory, 'postgres-init'),
    );
    assert.equal(
      readFileSync(join(directory, 'postgres-init/10-roles.sh'), 'utf8')
        .length > 0,
      true,
    );
    // Defaults: the qualified minimum server. Otherwise each heap and the
    // worker's drain budget follow the memory the operator gave the service.
    const memory =
      mode === 'kms'
        ? { api: [512, 256], worker: [768, 256], drainMiB: 640 }
        : { api: [1024, 512], worker: [2048, 682], drainMiB: 1707 };
    for (const service of ['api', 'worker']) {
      const [memoryMiB, heapMiB] = memory[service];
      assert.equal(
        Number(config.services[service].mem_limit),
        memoryMiB * 1024 * 1024,
      );
      assert.equal(
        Number(config.services[service].memswap_limit),
        memoryMiB * 1024 * 1024,
      );
      assert.equal(
        config.services[service].environment.NODE_OPTIONS,
        `--max-old-space-size=${String(heapMiB)}`,
      );
    }
    const api = parseApiConfig(config.services.api.environment);
    assert.deepEqual(api.identity.betterAuth.providers.google, {
      clientId: environment.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: environment.AUTH_GOOGLE_CLIENT_SECRET,
    });
    assert.deepEqual(api.identity.betterAuth.providers.github, {
      clientId: environment.AUTH_GITHUB_CLIENT_ID,
      clientSecret: environment.AUTH_GITHUB_CLIENT_SECRET,
    });
    for (const service of ['worker', 'migration', 'web', 'code-runner'])
      for (const variable of [
        'AUTH_FEDERATION_KEY',
        'AUTH_FEDERATION_KEY_VERSION',
        'AUTH_FEDERATION_PREVIOUS_KEYS',
        'AUTH_GOOGLE_CLIENT_ID',
        'AUTH_GOOGLE_CLIENT_SECRET',
        'AUTH_GITHUB_CLIENT_ID',
        'AUTH_GITHUB_CLIENT_SECRET',
      ])
        assert.equal(
          config.services[service].environment?.[variable],
          undefined,
        );
    assert.deepEqual(
      api.callbacks,
      parseWorkerConfig({
        ...config.services.worker.environment,
        WORKER_INSTANCE_ID: 'callback-qualification',
      }).callbacks,
    );
    for (const key of ['CALLBACK_TOKEN_KEY', 'CALLBACK_TOKEN_KEY_VERSION']) {
      assert.equal(
        parseEnv(readFileSync(join(directory, 'encryption.env'), 'utf8'))[key],
        generated[key],
      );
      for (const service of ['web', 'storage', 'code-runner', 'migration'])
        assert.equal(config.services[service].environment?.[key], undefined);
    }
    const worker = parseWorkerConfig({
      ...config.services.worker.environment,
      WORKER_INSTANCE_ID: 'fixture',
    });
    // The worker's own drain must act before the kernel does: a budget equal
    // to the cap meant the kernel always got there first.
    assert.equal(
      worker.resourceSafety.maximumRssBytes,
      memory.drainMiB * 1024 * 1024,
    );
    assert.ok(
      Number(config.services.worker.mem_limit) -
        worker.resourceSafety.maximumRssBytes >=
        128 * 1024 * 1024,
    );
    const scratchPath = '/var/lib/pertexo/artifact-scratch';
    assert.equal(worker.artifactScratchDirectory, scratchPath);
    const scratch = config.services.worker.volumes.find(
      (volume) => volume.target === scratchPath,
    );
    assert.equal(scratch.type, 'volume');
    assert.equal(scratch.source, undefined);
    assert.equal(scratch.read_only, undefined);
    assert.ok(
      !(config.services.worker.tmpfs ?? []).some((entry) =>
        entry.startsWith(scratchPath),
      ),
    );
    assert.ok(
      !(config.services['code-runner'].volumes ?? []).some(
        (volume) => volume.target === scratchPath,
      ),
    );
    const runner = config.services['code-runner'];
    const limits = codeContainerLimits(api.codeSettings);
    assert.equal(runner.network_mode, 'none');
    assert.equal(runner.networks, undefined);
    assert.equal(runner.ipc, 'none');
    assert.equal(runner.read_only, true);
    assert.equal(runner.user, '0:10001');
    assert.deepEqual(runner.cap_drop, ['ALL']);
    assert.deepEqual(
      new Set(runner.cap_add),
      new Set(['SETUID', 'SETGID', 'KILL']),
    );
    assert.ok(runner.security_opt.includes('no-new-privileges:true'));
    assert.equal(runner.oom_score_adj, -1000);
    assert.equal(Number(runner.mem_limit), limits.memoryMiB * 1048576);
    if (mode === 'kms') assert.equal(Number(runner.mem_limit), 1872 * 1048576);
    assert.equal(runner.memswap_limit, runner.mem_limit);
    assert.equal(Number(runner.cpus), limits.cpus);
    assert.equal(runner.pids_limit, limits.pids);
    assert.ok(runner.tmpfs[0].includes('noexec'));
    assert.ok(runner.tmpfs[0].includes('mode=0700'));
    assert.deepEqual(
      Object.keys(runner.environment)
        .filter((name) => !name.startsWith('CODE_'))
        .sort(),
      ['NODE_ENV', 'NODE_OPTIONS'],
    );
    const socketVolume = runner.volumes[0].source;
    assert.ok(
      config.services.worker.volumes.some(
        (volume) => volume.source === socketVolume,
      ),
    );
    for (const name of [
      'api',
      'web',
      'proxy',
      'storage',
      'postgres',
      'redis',
      'ops',
      'migration',
    ])
      assert.ok(
        !(config.services[name].volumes ?? []).some(
          (volume) => volume.source === socketVolume,
        ),
      );
    assert.equal(worker.systemMailDelivery.delivery.mode, transport);
    assert.equal(worker.invitationDelivery.delivery.mode, transport);
    for (const name of ['api', 'ops', 'migration']) {
      assert.equal(
        config.services[name].environment.SYSTEM_MAIL_SMTP_PASSWORD,
        undefined,
      );
      assert.equal(
        config.services[name].environment.AUTH_MAIL_EMAIL_API_KEY,
        undefined,
      );
    }
    if (transport === 'smtp') {
      assert.equal(
        config.services.worker.environment.AUTH_MAIL_EMAIL_API_KEY,
        undefined,
      );
      assert.equal(
        config.services.worker.environment.INVITATION_EMAIL_API_KEY,
        undefined,
      );
      assert.equal(
        worker.systemMailDelivery.delivery.auth.pass,
        'fixture-smtp-password',
      );
    }
    if (mode === 'self-managed')
      assert.deepEqual(api.connections, worker.connectionEncryption);
    else {
      assert.equal(
        api.connections.kmsKeyReference,
        worker.connectionEncryption.keyReference,
      );
      assert.equal(api.connections.region, worker.connectionEncryption.region);
    }
    assert.equal(
      config.services.api.environment.DATABASE_MAINTENANCE_URL,
      undefined,
    );
    assert.equal(config.services.api.depends_on.worker, undefined);
    const verification = parseEnv(
      readFileSync(join(directory, 'encryption.env'), 'utf8'),
    );
    assert.equal(
      verification.DATABASE_MAINTENANCE_URL,
      generated.DATABASE_MAINTENANCE_URL,
    );
    assert.ok(
      Object.keys(verification).every(
        (key) =>
          key.startsWith('CONNECTION_') ||
          key.startsWith('AWS_') ||
          key.startsWith('CALLBACK_TOKEN_') ||
          [
            'NODE_ENV',
            'DATABASE_MAINTENANCE_URL',
            'DATABASE_URL',
            'PUBLIC_WEB_ORIGIN',
          ].includes(key),
      ),
    );
    for (const file of ['encryption.env', 'api.env', 'worker.env'])
      assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
    if (mode === 'self-managed') {
      assert.equal(
        config.services.api.environment.AWS_ACCESS_KEY_ID,
        undefined,
      );
      assert.equal(verification.CONNECTION_KMS_KEY_REFERENCE, undefined);
      for (const service of ['storage', 'migration', 'ops'])
        assert.equal(
          config.services[service].environment.CONNECTION_SELF_MANAGED_KEY,
          undefined,
        );
      const old = join(directory, 'absent-verifier');
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              'infrastructure/single-server/storage/prepare.mjs',
              directory,
              old,
            ],
            { env: environment, stdio: 'pipe' },
          ),
        /Self-managed encryption requires a release/u,
      );
    }
    assert.equal(api.nodeEnv, 'production');
    assert.equal(api.observability.otlpHttpEndpoint, collector);
    assert.equal(
      parseWorkerConfig({
        ...config.services.worker.environment,
        WORKER_INSTANCE_ID: 'fixture',
      }).observability.otlpHttpEndpoint,
      collector,
    );
    assert.equal(
      config.services.worker.environment.AUTH_MAIL_KEY,
      config.services.api.environment.AUTH_MAIL_KEY,
    );
    assert.equal(
      config.services.worker.environment.INVITATION_TOKEN_KEY,
      config.services.api.environment.INVITATION_TOKEN_KEY,
    );
    assert.deepEqual(
      Object.entries(config.services)
        .filter(([, service]) => service.ports?.length)
        .map(([name]) => name),
      ['proxy'],
    );
    assert.equal(
      config.services.storage.environment.AWS_ACCESS_KEY_ID,
      undefined,
    );
    assert.equal(
      config.services.api.environment.STORAGE_ADMIN_SECRET_ACCESS_KEY,
      undefined,
    );
    assert.deepEqual(
      config.services.api.depends_on.migration.condition,
      'service_completed_successfully',
    );
    assert.deepEqual(
      config.services.worker.depends_on.migration.condition,
      'service_completed_successfully',
    );
  });
