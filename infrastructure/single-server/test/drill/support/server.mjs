import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { docker, must, mustDocker, run, waitFor } from './process.mjs';
import {
  BACKUP_CADDYFILE,
  BACKUP_LOGIN,
  MAIL_LOGIN,
  PUBLIC_HOSTS,
  breakWebUpstream,
  overlayCaddyfile,
  overlayCommonScript,
  overlayCompose,
  overlayNetworkName,
  readableReleases,
} from './overlay.mjs';
import {
  RUNTIME_IMAGE,
  removeReleaseTags,
  requireImages,
  tagRelease,
} from './images.mjs';

const UBUNTU =
  'ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852';
const DOCKER_CLI =
  'docker:29-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb';
const RC_IMAGE =
  'rustfs/rc:v0.1.36@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699';
const repositoryRoot = new URL('../../../../../', import.meta.url).pathname;

export const project = process.env.DRILL_PROJECT ?? 'pertexo-b1-singleserver';
export const httpPort = Number(process.env.DRILL_HTTP_PORT ?? 64480);
export const httpsPort = Number(process.env.DRILL_HTTPS_PORT ?? 64443);
const control = `${project}-control`;
const volume = `${project}-root`;
const filler = `${project}-filler`;
const network = `${project}_private`;

/**
 * A fresh Ubuntu server with a non-root `pertexo` login, Docker's CLI and no Node:
 * what the runbook starts from. Its files live on a Docker volume so the daemon sees
 * ordinary Linux ownership and modes, on any host OS.
 */
export async function createServer() {
  await requireImages();
  await destroyServer();
  await mustDocker(['volume', 'create', volume]);
  const root = await mustDocker([
    'volume',
    'inspect',
    '--format',
    '{{.Mountpoint}}',
    volume,
  ]);
  await mustDocker(['build', '--quiet', '--tag', `${control}:local`, '-'], {
    input: `FROM ${UBUNTU}
COPY --from=${DOCKER_CLI} /usr/local/bin/docker /usr/local/bin/docker
COPY --from=${DOCKER_CLI} /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates openssl && useradd --uid 1001 --create-home pertexo
`,
  });
  const socketGroup = await mustDocker([
    'run',
    '--rm',
    '--entrypoint',
    'stat',
    '-v',
    '/var/run/docker.sock:/docker.sock',
    `${control}:local`,
    '-c',
    '%g',
    '/docker.sock',
  ]);
  await mustDocker([
    'run',
    '--detach',
    '--name',
    control,
    '--group-add',
    socketGroup,
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${volume}:${root}`,
    `${control}:local`,
    'sleep',
    'infinity',
  ]);
  await mustDocker(['exec', control, 'chown', 'pertexo:pertexo', root]);
  const exec = (script, { input, env = {}, timeout } = {}) =>
    docker(
      [
        'exec',
        '-i',
        '--user',
        'pertexo',
        '--workdir',
        root,
        '-e',
        `PERTEXO_BETA_ROOT=${root}`,
        ...Object.entries(env).flatMap(([key, value]) => [
          '-e',
          `${key}=${value}`,
        ]),
        control,
        'bash',
        '-c',
        script,
      ],
      { input, timeout },
    );
  const mustExec = async (script, options) => {
    const result = await exec(script, options);
    if (result.status !== 0)
      throw new Error(`${script}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const scripts = `${root}/repository/infrastructure/single-server`;
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const composeFor = (commit, args, options) =>
    exec(
      `source ${scripts}/common.sh; select_release ${commit}; compose ${args.map(quote).join(' ')}`,
      options,
    );
  const server = {
    root,
    exec,
    mustExec,
    composeFor,
    /** Runs an operator script exactly as the runbook does. */
    script: (name, args = [], options) =>
      exec(`${scripts}/${name} ${args.map(quote).join(' ')}`, options),
    current: () => mustExec('cat state/current'),
    containerOf: async (service) =>
      mustDocker([
        'ps',
        '--all',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        `label=com.docker.compose.service=${service}`,
      ]),
  };
  await installCertificates(server);
  server.ca = await mustExec('cat drill-tls/ca.crt');
  server.releases = await installRepository(server);
  for (const release of Object.values(server.releases))
    await tagRelease(release);
  return server;
}

async function installCertificates({ mustExec }) {
  const names = Object.values(PUBLIC_HOSTS)
    .map((host) => `DNS:${host}`)
    .join(',');
  await mustExec(`
set -e
umask 022
mkdir -p drill-tls drill-backup-data
chmod 777 drill-backup-data
cd drill-tls
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout ca.key -out ca.crt -subj /CN=pertexo-drill-ca 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout site.key -out site.csr -subj /CN=drill.test 2>/dev/null
printf 'subjectAltName=${names}\\n' > site.ext
openssl x509 -req -in site.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -out site.crt -extfile site.ext 2>/dev/null
chmod 644 site.key
`);
  await mustExec('cat > drill-tls/backup.Caddyfile', {
    input: BACKUP_CADDYFILE,
  });
}

/** Clones this working tree the way a server does, with three linear releases. */
async function installRepository(server) {
  const { mustExec, root } = server;
  await mustExec('mkdir -p tree && git init --quiet --bare -b main origin.git');
  const listing = await must(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repositoryRoot },
  );
  const files = listing
    .split('\0')
    .filter((file) => file && existsSync(repositoryRoot + file));
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['--null', '-T', '-', '-cf', '-'], {
      cwd: repositoryRoot,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const extract = spawn(
      'docker',
      [
        'exec',
        '-i',
        '--user',
        'pertexo',
        control,
        'tar',
        '--warning=no-unknown-keyword',
        '-x',
        '-C',
        `${root}/tree`,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    tar.stdout.pipe(extract.stdin);
    tar.stdin.end(files.join('\0') + '\0');
    tar.once('error', reject);
    extract.once('error', reject);
    extract.once('close', (status) =>
      status === 0 ? resolve() : reject(new Error(`Extract exited ${status}`)),
    );
  });
  const singleServer = 'infrastructure/single-server';
  const read = (name) =>
    readFileSync(`${repositoryRoot}${singleServer}/${name}`, 'utf8');
  const settings = { project, httpPort, httpsPort };
  const compose = overlayCompose(read('compose.yaml'), settings);
  const write = (name, content) =>
    mustExec(`cat > tree/${singleServer}/${name}`, { input: content });
  await write('compose.yaml', compose);
  await write('common.sh', overlayCommonScript(read('common.sh'), settings));
  for (const name of ['deploy.sh', 'restore.sh'])
    await write(name, overlayNetworkName(read(name), settings));
  await write('Caddyfile', overlayCaddyfile(read('Caddyfile')));
  const commit = (message) =>
    mustExec(
      `cd tree && git add -A && git -c user.name=drill -c user.email=drill@drill.test commit --quiet --allow-empty -m ${message} && git rev-parse HEAD`,
    );
  await mustExec('cd tree && git init --quiet -b main');
  const first = await commit('first');
  await write('compose.yaml', breakWebUpstream(compose));
  const broken = await commit('broken');
  await write('compose.yaml', compose);
  const repaired = await commit('repaired');
  await mustExec(`
set -e
cd tree
git remote add origin ${root}/origin.git
git push --quiet origin main
cd ..
rm -rf tree
git clone --quiet ${root}/origin.git repository
`);
  return { first, broken, repaired };
}

/** Writes the operator's environment, as the runbook's configuration step does. */
export async function configure(server) {
  const generated = await server.mustExec(
    `docker run --rm --read-only --network none -v "$PWD/repository/infrastructure/single-server/generate-secrets.mjs:/generate-secrets.mjs:ro" --entrypoint node ${RUNTIME_IMAGE} /generate-secrets.mjs --encryption=self-managed`,
  );
  const settings = {
    PUBLIC_WEB_ORIGIN: `https://${PUBLIC_HOSTS.app}`,
    ARTIFACT_STORE_ENDPOINT: `https://${PUBLIC_HOSTS.files}`,
    AUTH_MAIL_FROM: 'security@drill.test',
    INVITATION_EMAIL_FROM: 'invites@drill.test',
    SYSTEM_MAIL_TRANSPORT: 'smtp',
    SYSTEM_MAIL_SMTP_HOST: PUBLIC_HOSTS.mail,
    SYSTEM_MAIL_SMTP_PORT: '1025',
    SYSTEM_MAIL_SMTP_TLS: 'starttls',
    SYSTEM_MAIL_SMTP_USER: MAIL_LOGIN.user,
    SYSTEM_MAIL_SMTP_PASSWORD: MAIL_LOGIN.pass,
    BACKUP_STORE_ENDPOINT: `https://${PUBLIC_HOSTS.backup}`,
    BACKUP_STORE_REGION: 'us-east-1',
    BACKUP_STORE_BUCKET: BACKUP_LOGIN.bucket,
    BACKUP_STORE_ACCESS_KEY_ID: BACKUP_LOGIN.accessKey,
    BACKUP_STORE_SECRET_ACCESS_KEY: BACKUP_LOGIN.secretKey,
    ALERT_WEBHOOK_URL: `http://${PUBLIC_HOSTS.alerts}:8080/alert`,
    BACKUP_HEARTBEAT_URL: `http://${PUBLIC_HOSTS.alerts}:8080/heartbeat`,
  };
  const example = readFileSync(
    `${repositoryRoot}infrastructure/single-server/.env.production.example`,
    'utf8',
  );
  const lines = example
    .split('\n')
    .filter((line) => !line.startsWith('#') && line.includes('='))
    .filter((line) => {
      const key = line.slice(0, line.indexOf('='));
      return (
        !(key in settings) &&
        key !== 'AUTH_MAIL_EMAIL_API_KEY' &&
        key !== 'INVITATION_EMAIL_API_KEY'
      );
    });
  const content = [
    ...lines,
    ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
    generated,
    '',
  ].join('\n');
  await server.mustExec(
    'umask 077; cat > .env.production; chmod 600 .env.production',
    {
      input: content,
    },
  );
}

/**
 * Gets past a failed first deploy so the later steps can still run. A half-started
 * Postgres keeps a data directory without roles, so its volumes have to go too.
 */
export async function recoverFromFailedInstall(server) {
  const { first } = server.releases;
  const stopped = await server.composeFor(first, [
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  if (stopped.status !== 0) throw new Error(stopped.stderr);
  const scripts = 'repository/infrastructure/single-server';
  const common = await server.mustExec(`cat ${scripts}/common.sh`);
  await server.mustExec(`cat > ${scripts}/common.sh`, {
    input: `${readableReleases(common)}\n`,
  });
  await server.mustExec(`chmod -R a+rX releases/${first}`);
  const deployed = await server.script('deploy.sh', [first]);
  if (deployed.status !== 0)
    throw new Error(`Deploy failed: ${deployed.stdout}\n${deployed.stderr}`);
}

/** The off-server bucket an operator creates up front. */
export const createBackupBucket = (server) =>
  server.mustExec(
    `docker run --rm --read-only --tmpfs /tmp --network ${network} -e RC_CONFIG_DIR=/tmp/rc -e RC_HOST_internal=http://${BACKUP_LOGIN.accessKey}:${BACKUP_LOGIN.secretKey}@drill-backup-store:9000 --entrypoint rc ${RC_IMAGE} bucket create --ignore-existing internal/${BACKUP_LOGIN.bucket}`,
  );

/** Scripts on the server reach the stand-in alert receiver by name, as a real URL. */
export const joinPrivateNetwork = () =>
  mustDocker(['network', 'connect', network, control]);
export const leavePrivateNetwork = () =>
  docker(['network', 'disconnect', network, control]);

/**
 * Keeps a stopped API from getting its old address back: Docker often hands out a
 * different one anyway, and this makes that certain.
 */
export async function withApiMovedDuring(server, operation) {
  const api = await server.containerOf('api');
  const addressOf = async (container) =>
    mustDocker([
      'inspect',
      '--format',
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      container,
    ]);
  const address = await addressOf(api);
  let finished = false;
  const hold = waitFor(
    async () => {
      if (finished) return true;
      const state = await docker([
        'inspect',
        '--format',
        '{{.State.Running}}',
        api,
      ]);
      if (state.stdout.trim() === 'true') return false;
      // Docker can take a moment to release the address after the stop.
      await docker(['rm', '--force', filler]);
      const taken = await docker([
        'run',
        '--detach',
        '--name',
        filler,
        '--network',
        network,
        '--ip',
        address,
        '--entrypoint',
        'sleep',
        RUNTIME_IMAGE,
        '900',
      ]);
      return taken.status === 0;
    },
    { what: 'the old API address', every: 100, timeout: 600_000 },
  );
  const result = await operation();
  finished = true;
  await hold;
  await docker(['rm', '--force', filler]);
  const moved = (await addressOf(await server.containerOf('api'))) !== address;
  return { ...result, apiMoved: moved };
}

/**
 * A kill the way the kernel does it, from outside the container. `docker kill` won't
 * do: Docker counts it as a deliberate stop and the restart policy leaves it down.
 */
export async function killLikeTheKernel(container) {
  const pid = await mustDocker([
    'inspect',
    '--format',
    '{{.State.Pid}}',
    container,
  ]);
  await mustDocker([
    'run',
    '--rm',
    '--pid',
    'host',
    '--user',
    '0',
    '--entrypoint',
    'sh',
    RUNTIME_IMAGE,
    '-c',
    `kill -9 ${pid}`,
  ]);
}

export async function destroyServer() {
  const owned = await run('docker', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  const containers = owned.stdout.split('\n').filter(Boolean);
  await docker(['rm', '--force', '--volumes', filler, control, ...containers]);
  await docker(['network', 'rm', network]);
  const volumes = await run('docker', [
    'volume',
    'ls',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  for (const name of [...volumes.stdout.split('\n').filter(Boolean), volume])
    await docker(['volume', 'rm', '--force', name]);
  await removeReleaseTagsFromLabel();
}

async function removeReleaseTagsFromLabel() {
  const images = await run('docker', [
    'images',
    '--format',
    '{{.Tag}}',
    'ghcr.io/vigani1/pertexo',
  ]);
  const local = images.stdout
    .split('\n')
    .filter((tag) => /^[0-9a-f]{40}$/u.test(tag));
  // Only images the drill labelled: none of these were ever pulled from a registry.
  const labelled = [];
  for (const tag of local) {
    const base = await run('docker', [
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "pertexo.drill"}}',
      `ghcr.io/vigani1/pertexo:${tag}`,
    ]);
    if (base.stdout.trim() === 'true') labelled.push(tag);
  }
  await removeReleaseTags(labelled);
}
