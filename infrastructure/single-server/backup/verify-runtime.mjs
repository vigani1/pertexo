import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';

const image = process.argv[2];
if (!image) throw new Error('usage: verify-runtime.mjs <runtime-image>');
const directory = mkdtempSync(join(tmpdir(), 'pertexo-runtime-helpers-'));
try {
  for (const { mode, transport } of ['kms', 'self-managed'].flatMap((mode) =>
    ['resend', 'smtp'].map((transport) => ({ mode, transport })),
  )) {
    const prepared = join(directory, mode + '-' + transport);
    mkdirSync(prepared, { mode: 0o700 });
    const env = {
      ...parseEnv(
        execFileSync(
          process.execPath,
          [
            'infrastructure/single-server/generate-secrets.mjs',
            '--encryption=' + mode,
          ],
          { encoding: 'utf8' },
        ),
      ),
      NODE_ENV: 'production',
      AUTH_MAIL_MODE: 'durable',
      SESSION_COOKIE_SECURE: 'true',
      PUBLIC_WEB_ORIGIN: 'https://app.example.test',
      ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
      ARTIFACT_STORE_REGION: 'us-east-1',
      ARTIFACT_STORE_BUCKET: 'artifacts',
      ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
      AUTH_MAIL_FROM: 'security@example.test',
      SYSTEM_MAIL_TRANSPORT: transport,
      ...(transport === 'smtp'
        ? {
            SYSTEM_MAIL_SMTP_HOST: 'smtp.example.test',
            SYSTEM_MAIL_SMTP_TLS: 'starttls',
            SYSTEM_MAIL_SMTP_USER: 'fixture-user',
            SYSTEM_MAIL_SMTP_PASSWORD: " pa'ss\\wo$rd# ",
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
          }
        : {
            CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: JSON.stringify([
              { version: '0', key: randomBytes(32).toString('base64') },
            ]),
          }),
      TRUST_PROXY_CIDRS: '172.30.42.0/24',
      BACKUP_STORE_ENDPOINT: 'https://backup.example.test',
      BACKUP_STORE_REGION: 'us-east-1',
      BACKUP_STORE_BUCKET: 'backups',
      BACKUP_STORE_ACCESS_KEY_ID: 'fixture-backup',
      BACKUP_STORE_SECRET_ACCESS_KEY: 'fixture-backup-secret',
    };
    const config = join(directory, mode + '-' + transport + '.env');
    writeFileSync(
      config,
      Object.entries(env)
        .filter(([key]) => key !== 'SYSTEM_MAIL_SMTP_PASSWORD')
        .map(([key, value]) => key + "='" + value + "'\n")
        .join(''),
      { mode: 0o600 },
    );
    const run = (args, status = 0) => {
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--read-only',
          '--network',
          'none',
          '--user',
          process.getuid() + ':' + process.getgid(),
          '-v',
          config + ':/run/pertexo.env:ro',
          '-v',
          prepared + ':/prepared',
          '-v',
          resolve('infrastructure/single-server') +
            ':/workspace/infrastructure/single-server:ro',
          ...(transport === 'smtp'
            ? [
                '--env',
                'SYSTEM_MAIL_SMTP_PASSWORD=' + env.SYSTEM_MAIL_SMTP_PASSWORD,
              ]
            : []),
          image,
          'node',
          '--env-file=/run/pertexo.env',
          ...args,
        ],
        { encoding: 'utf8', timeout: 30000 },
      );
      assert.equal(result.status, status, result.stderr);
      return result;
    };
    run(['infrastructure/single-server/storage/prepare.mjs', '/prepared']);
    if (transport === 'smtp') {
      // Rendered Compose config escapes dollar signs; assert the actual process value.
      const manifest = join(prepared, 'mail.compose.json');
      writeFileSync(
        manifest,
        JSON.stringify({
          services: {
            fixture: {
              image,
              network_mode: 'none',
              read_only: true,
              env_file: [join(prepared, 'worker.env')],
              command: [
                'node',
                '--input-type=module',
                '--eval',
                // Compose interpolates commands too; $$ represents a literal $.
                (
                  "import assert from 'node:assert/strict'; assert.equal(process.env.SYSTEM_MAIL_SMTP_PASSWORD," +
                  JSON.stringify(env.SYSTEM_MAIL_SMTP_PASSWORD) +
                  "); assert.equal(process.env.SYSTEM_MAIL_TRANSPORT,'smtp');"
                ).replaceAll('$', () => '$$'),
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      const actual = spawnSync(
        'docker',
        [
          'compose',
          '--env-file',
          '/dev/null',
          '-p',
          `pertexo-smtp-qualification-${process.pid}-${mode}`,
          '-f',
          manifest,
          'run',
          '--rm',
          '--no-deps',
          '--pull',
          'never',
          'fixture',
        ],
        { encoding: 'utf8', timeout: 30000 },
      );
      assert.equal(actual.status, 0, actual.stderr);
    }

    run(['infrastructure/single-server/backup/prepare.mjs', '/prepared']);
    run([
      '--input-type=module',
      '--eval',
      [
        "import assert from 'node:assert/strict';",
        "import {parseWorkerConfig} from './apps/worker/dist/config/worker.js';",
        "import {createSystemMailClient} from './packages/integrations/dist/server.js';",
        "const config=parseWorkerConfig({...process.env,WORKER_INSTANCE_ID:'fixture'});",
        'for(const delivery of [config.systemMailDelivery,config.invitationDelivery]) {',
        ' assert.equal(delivery.delivery.mode,process.env.SYSTEM_MAIL_TRANSPORT);',
        ' const client=createSystemMailClient(delivery.delivery);',
        " assert.equal(client.deduplicates,process.env.SYSTEM_MAIL_TRANSPORT==='resend');",
        " const result=await client.sendNotification({fromEmail:'a@example.test',toEmail:'b@example.test',subject:'test',text:'test',idempotencyKey:'fixture',timeoutMillis:100,signal:AbortSignal.abort(),beforeDispatch:async()=>{throw new Error('Unexpected dispatch');}});",
        " assert.equal(result.kind,'retryable');",
        '}',
      ].join(''),
    ]);
    run([
      '--input-type=module',
      '--eval',
      "await import('./infrastructure/single-server/backup/copy-objects.mjs')",
    ]);
    run([
      '--input-type=module',
      '--eval',
      [
        "import assert from 'node:assert/strict';",
        "import {Readable} from 'node:stream';",
        "import {parseConnectionEncryptionConfig,verifyStoredEncryptionKeys,createConnectionEnvelopeEncryption,createWebhookTriggerEnvelopeEncryption} from './packages/integrations/dist/server.js';",
        'const config=parseConnectionEncryptionConfig(process.env,true);',
        'assert.deepEqual(await verifyStoredEncryptionKeys(config,Readable.from([]),AbortSignal.timeout(1000)),{connectionKeys:0,webhookKeys:0});',
        "if('mode' in config){",
        ' const old={...config,encryption:{current:config.encryption.previous[0],previous:[]}};',
        " const base={workspaceId:'11111111-1111-4111-8111-111111111111',secretVersionId:'33333333-3333-4333-8333-333333333333'};",
        " for(const kind of ['connection','webhook']){",
        "  const factory=kind==='connection'?createConnectionEnvelopeEncryption:createWebhookTriggerEnvelopeEncryption;",
        '  const first=factory(old),next=factory(config);',
        "  const context={...base,[kind==='connection'?'connectionId':'triggerId']:'22222222-2222-4222-8222-222222222222'};",
        "  const expected=Buffer.alloc(kind==='connection'?17:32,7);",
        '  let opened;',
        '  try{const sealed=await first.encryption.seal(Buffer.from(expected),context);opened=await next.encryption.open(sealed,context);assert.deepEqual(Buffer.from(opened),expected);}',
        '  finally{opened?.fill(0);first.close();next.close();}',
        ' }',
        '}',
      ].join('\n'),
    ]);
    const failure = run(
      ['infrastructure/single-server/encryption/verify.mjs'],
      1,
    );
    assert.equal(failure.stdout, '');
    assert.equal(JSON.parse(failure.stderr).code, 'inventory_unavailable');
    if (mode === 'self-managed')
      assert.ok(!failure.stderr.includes(env.CONNECTION_SELF_MANAGED_KEY));
    for (const filename of ['api.env', 'worker.env', 'encryption.env'])
      assert.equal(statSync(join(prepared, filename)).mode & 0o777, 0o600);
    const verification = parseEnv(
      readFileSync(join(prepared, 'encryption.env'), 'utf8'),
    );
    assert.equal(verification.CONNECTION_ENCRYPTION_MODE, mode);
    assert.equal(
      readFileSync(join(prepared, 'source-bucket'), 'utf8'),
      'artifacts',
    );
    assert.equal(
      readFileSync(join(prepared, 'backup-bucket'), 'utf8'),
      'backups',
    );
    console.log(
      'Production-image helpers, credential crypto and safe preflight failure passed: ' +
        mode,
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
