import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const runtimeImage =
  'node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
const image = execFileSync(
  'docker',
  [
    'compose',
    '-f',
    'infrastructure/single-server/backup/compose.yaml',
    'config',
    '--images',
  ],
  { encoding: 'utf8' },
).trim();

test(
  'private file configuration protects crypt and S3 secrets on every helper path',
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'pertexo-backup-secrets-4600-'),
    );
    const work = join(directory, 'operation');
    const settings = {
      ARTIFACT_STORE_ACCESS_KEY_ID: 'source-access-4600',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: ' source#`"secret\\4600 ',
      ARTIFACT_STORE_ENDPOINT: 'https://source.example.test',
      ARTIFACT_STORE_REGION: 'us-east-1',
      ARTIFACT_STORE_BUCKET: 'artifacts',
      BACKUP_STORE_ACCESS_KEY_ID: 'destination-access-4600',
      BACKUP_STORE_SECRET_ACCESS_KEY: 'destination#`"secret\\4600',
      BACKUP_STORE_ENDPOINT: 'https://backup.example.test',
      BACKUP_STORE_REGION: 'us-east-1',
      BACKUP_STORE_BUCKET: 'backups',
      BACKUP_CRYPT_PASSWORD: ' password#`"4600 ',
      BACKUP_CRYPT_SALT: ' salt#`"4600 ',
    };
    const tools = resolve('infrastructure/single-server/backup');
    const common = resolve(
      'infrastructure/single-server/release-operations.sh',
    );
    let child;
    try {
      await mkdir(work, { mode: 0o700 });
      await mkdir(join(directory, 'bin'));
      await writeFile(
        join(directory, 'settings.json'),
        JSON.stringify(settings),
        { mode: 0o600 },
      );
      await writeFile(
        join(directory, '.env.production'),
        Object.entries(settings)
          .map(([key, value]) => `${key}='${value}'`)
          .join('\n'),
        { mode: 0o600 },
      );
      await writeFile(join(work, 'objects.json'), '[]');
      // Create/start lets the outside Docker adapter inspect even a fast command
      // before its --rm removes the container. Actual entry points remain unchanged.
      await writeFile(
        join(directory, 'bin/docker'),
        `#!${process.execPath} --
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const real = ${JSON.stringify(execFileSync('which', ['docker'], { encoding: 'utf8' }).trim())};
const root = ${JSON.stringify(directory)};
const work = ${JSON.stringify(work)};
const settings = JSON.parse(fs.readFileSync(root + '/settings.json', 'utf8'));
const secretValues = Object.entries(settings).filter(([key]) => /ACCESS_KEY|CRYPT_/u.test(key)).map(([, value]) => value);
if (fs.existsSync(work + '/rclone.conf')) {
  for (const line of fs.readFileSync(work + '/rclone.conf', 'utf8').split('\\n')) {
    const match = /^(?:access_key_id|secret_access_key|password2?) = \`(.*)\`$/u.exec(line);
    if (match) secretValues.push(match[1]);
  }
}
const check = (text, surface) => { if (secretValues.some((value) => text.includes(value))) throw new Error(surface + ' exposed a helper secret'); };
let args = process.argv.slice(2);
if (args[0] !== 'run') { const r = spawnSync(real, args, { stdio: 'inherit' }); process.exit(r.status ?? 1); }
const imageIndex = args.findIndex((arg) => arg.startsWith('ghcr.io/vigani1/pertexo:'));
if (imageIndex >= 0) args.splice(imageIndex, 1, '-v', ${JSON.stringify(resolve('.'))} + ':/workspace:ro', '-w', '/workspace', ${JSON.stringify(runtimeImage)});
const cid = execFileSync(real, ['create', ...args.slice(1)], { encoding: 'utf8' }).trim();
try {
  const inspect = (value) => {
    if (typeof value === 'string') check(value, 'docker inspect');
    else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
  };
  inspect(JSON.parse(execFileSync(real, ['inspect', cid], { encoding: 'utf8' })));
  check(execFileSync('ps', ['-axo', 'pid,args'], { encoding: 'utf8' }), 'host ps');
  fs.appendFileSync(root + '/checked', JSON.stringify({ image: args.find((arg) => arg.startsWith('rclone/rclone:') || arg === ${JSON.stringify(runtimeImage)}), inspect: true, hostPs: true }) + '\\n');
  const r = spawnSync(real, ['start', '--attach', ...(args.includes('-i') ? ['--interactive'] : []), cid], { stdio: ['inherit', 'pipe', 'pipe'] });
  check(String(r.stdout) + String(r.stderr), 'helper logs');
  process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
  process.exitCode = r.status ?? 1;
} finally { spawnSync(real, ['rm', '--force', cid], { stdio: 'ignore' }); }
`,
        { mode: 0o755 },
      );
      if (process.platform !== 'linux')
        await writeFile(
          join(directory, 'bin/stat'),
          `#!${process.execPath} --\nconsole.log((require('node:fs').statSync(process.argv.at(-1)).mode & 0o777).toString(8));\n`,
          { mode: 0o755 },
        );
      child = spawn(
        'bash',
        [
          '-c',
          `
set -Eeuo pipefail
source "$COMMON"
work="$WORK"
backup_transport_image="$RCLONE_IMAGE"
backup_tools="$TOOLS"
backup_network=none
SERVICE_VERSION=privacy-fixture
backup_helper prepare.mjs /prepared
rclone listremotes
backup_helper restore-objects.mjs validate /backup
`,
        ],
        {
          env: {
            ...process.env,
            PERTEXO_BETA_ROOT: directory,
            WORK: work,
            TOOLS: tools,
            COMMON: common,
            RCLONE_IMAGE: image,
            PATH: `${directory}/bin:${process.env.PATH}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const [code] = await once(child, 'close');
      assert.equal(code, 0, output);
      const config = JSON.parse(
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '-v',
            `${work}/rclone.conf:/run/rclone.conf:ro`,
            image,
            '--config',
            '/run/rclone.conf',
            'config',
            'dump',
          ],
          { encoding: 'utf8' },
        ),
      );
      assert.equal(
        config.source.secret_access_key,
        settings.ARTIFACT_STORE_SECRET_ACCESS_KEY,
      );
      assert.equal(
        config.backup.secret_access_key,
        settings.BACKUP_STORE_SECRET_ACCESS_KEY,
      );
      assert.ok(config.crypt.password && config.crypt.password2);
      assert.equal((await stat(join(work, 'rclone.conf'))).mode & 0o777, 0o600);
      const checked = (await readFile(join(directory, 'checked'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(
        checked.filter((entry) => entry.image === runtimeImage).length,
        2,
      );
      assert.equal(checked.filter((entry) => entry.image === image).length, 3);
      for (const value of [
        settings.BACKUP_CRYPT_PASSWORD,
        settings.BACKUP_CRYPT_SALT,
        config.crypt.password,
        config.crypt.password2,
      ])
        assert.ok(
          !output.includes(value),
          'operator output keeps crypt secrets private',
        );
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'close');
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
