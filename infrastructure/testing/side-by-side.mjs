import { execFile, spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const SLOT_PORT_STEP = 100;
// The SAML journey serves its cross-site app on the web port's neighbour.
const SLOT_WEB_PORT_STEP = 10;
const SERVICES = ['postgres', 'redis', 'artifact-store'];
const URL_VARIABLES = [
  ['DATABASE_ADMIN_URL', 'POSTGRES_PORT'],
  ['DATABASE_MIGRATION_URL', 'POSTGRES_PORT'],
  ['DATABASE_URL', 'POSTGRES_PORT'],
  ['DATABASE_MAINTENANCE_URL', 'POSTGRES_PORT'],
  ['REDIS_URL', 'REDIS_PORT'],
  ['ARTIFACT_STORE_ENDPOINT', 'ARTIFACT_STORE_PORT'],
];

/** A slot is a whole stack: its own services, ports and web build. */
export function slotEnvironment(base, slot) {
  const port = (name) => Number(base[name]) + slot * SLOT_PORT_STEP;
  const environment = {
    // Still `pertexo-ci-<n>-<n>-<suffix>`, the only form ownership checks accept.
    COMPOSE_PROJECT_NAME: base.COMPOSE_PROJECT_NAME.replace(
      /-(browser|integration)$/u,
      `${String(slot)}-$1`,
    ),
    POSTGRES_PORT: String(port('POSTGRES_PORT')),
    REDIS_PORT: String(port('REDIS_PORT')),
    ARTIFACT_STORE_PORT: String(port('ARTIFACT_STORE_PORT')),
    PERTEXO_LIVE_WEB_PORT: String(
      Number(base.PERTEXO_LIVE_WEB_PORT ?? 4174) + slot * SLOT_WEB_PORT_STEP,
    ),
    PERTEXO_WEB_OUT_DIR: `dist/live-${String(slot)}`,
  };
  environment.WORKFLOW_CONCURRENCY_COMPOSE_PROJECT =
    environment.COMPOSE_PROJECT_NAME;
  environment.CONNECTION_HEALTH_COMPOSE_PROJECT =
    environment.COMPOSE_PROJECT_NAME;
  for (const [variable, portName] of URL_VARIABLES) {
    const url = new URL(base[variable]);
    url.port = environment[portName];
    environment[variable] = url.href.replace(/\/$/u, '');
  }
  return environment;
}

/** Hands the next journey to whichever slot is free, so slow ones don't queue others. */
export async function runSideBySide(journeys, slots, run) {
  const waiting = [...journeys];
  const results = [];
  await Promise.all(
    slots.map(async (slot) => {
      for (
        let journey = waiting.shift();
        journey !== undefined;
        journey = waiting.shift()
      )
        results.push(await run(journey, slot));
    }),
  );
  return results;
}

export async function compose(env, ...args) {
  await execute(
    '.github/scripts/retry-once.sh',
    ['docker', 'compose', ...args],
    {
      env,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

async function containerId(env, service) {
  const { stdout } = await execute('docker', ['compose', 'ps', '-q', service], {
    env,
  });
  const { stdout: id } = await execute(
    'docker',
    ['inspect', '--format', '{{.Id}}', stdout.trim()],
    { env },
  );
  return id.trim();
}

export async function startStack(slot) {
  const environment = { ...process.env, ...slotEnvironment(process.env, slot) };
  await compose(environment, 'up', '-d', '--wait', ...SERVICES);
  return {
    ...environment,
    EDITOR_BROWSER_OWNERSHIP_MANIFEST: JSON.stringify({
      project: environment.COMPOSE_PROJECT_NAME,
      postgres: {
        id: await containerId(environment, 'postgres'),
        port: Number(environment.POSTGRES_PORT),
      },
      redis: {
        id: await containerId(environment, 'redis'),
        port: Number(environment.REDIS_PORT),
      },
      artifactStore: {
        id: await containerId(environment, 'artifact-store'),
        port: Number(environment.ARTIFACT_STORE_PORT),
      },
    }),
  };
}

export function runLogged(journey, { args, env }, slotEnv, directory) {
  const logPath = join(directory, `${journey}.log`);
  const log = createWriteStream(logPath);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, {
      env: { ...slotEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const finish = (passed) => {
      log.end(() => {
        resolve({
          journey,
          passed,
          seconds: Math.round((Date.now() - started) / 1000),
          logPath,
        });
      });
    };
    child.once('error', () => {
      finish(false);
    });
    child.once('close', (code) => {
      finish(code === 0);
    });
  });
}

export function report({ journey, passed, seconds, logPath }) {
  // Whole logs, one journey at a time: side-by-side output can't be read otherwise.
  console.log(
    `::group::${journey}: ${passed ? 'passed' : 'FAILED'} in ${String(seconds)}s`,
  );
  console.log(readFileSync(logPath, 'utf8'));
  console.log('::endgroup::');
  if (!passed) console.log(`::error::Failed: ${journey}`);
}

export function pullServices() {
  return compose(process.env, 'pull', '--quiet', ...SERVICES);
}

export function stopStacks(environments) {
  return Promise.allSettled(
    environments.map((environment) =>
      execute('docker', ['compose', 'down', '-v', '--remove-orphans'], {
        env: environment,
      }),
    ),
  );
}

export async function printServiceLogs(environment) {
  const { stdout } = await execute(
    'docker',
    ['compose', 'logs', '--no-color', '--timestamps'],
    { env: environment, maxBuffer: 64 * 1024 * 1024 },
  );
  console.log(stdout);
}

export function summary(results) {
  return results
    .map(
      ({ journey, passed, seconds }) =>
        `${passed ? 'ok    ' : 'FAILED'} ${String(seconds).padStart(4)}s ${journey}`,
    )
    .join('\n');
}
