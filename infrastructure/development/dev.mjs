// One command for local development: start Postgres, Redis and the object
// store, build, migrate, run the API, worker and web app, and make sure a
// development account exists.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dirname, '../..');
const developmentAccount = Object.freeze({
  email: 'dev@pertexo.local',
  password: 'pertexo-development',
  name: 'Development',
});

function loadEnvironment() {
  const file = resolve(root, '.env');
  if (!existsSync(file)) {
    copyFileSync(resolve(root, '.env.example'), file);
    process.stdout.write('Created .env from .env.example\n');
  }
  // Values already in the shell win over the file.
  return { ...parseEnv(readFileSync(file, 'utf8')), ...process.env };
}

function run(command, args, environment) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', fail);
    child.once('close', (code) => {
      if (code === 0) done();
      else fail(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

function start(name, args, environment) {
  const child = spawn('pnpm', args, {
    cwd: root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}] `;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  }
  return child;
}

async function waitForApi(origin, signal) {
  for (;;) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`${origin}/health/ready`, { signal });
      if (response.ok) return;
    } catch {
      // The API is still starting.
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

async function ensureDevelopmentAccount(environment, signal) {
  const apiOrigin = `http://127.0.0.1:${environment.PORT ?? '3000'}`;
  await waitForApi(apiOrigin, signal);
  const response = await fetch(`${apiOrigin}/v1/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: environment.PUBLIC_WEB_ORIGIN ?? 'http://127.0.0.1:5173',
    },
    body: JSON.stringify(developmentAccount),
    signal,
  });
  // An existing account answers with a conflict; both outcomes are fine.
  if (!response.ok && response.status !== 422 && response.status !== 409)
    throw new Error(`Development sign-up failed with ${response.status}`);
  // Local mail is never delivered, so mark only this account verified.
  await run(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '--quiet',
      '-U',
      environment.POSTGRES_SUPERUSER ?? 'postgres',
      '-d',
      environment.POSTGRES_DB ?? 'pertexo',
      '-c',
      `update app.users set email_verified=true where email='${developmentAccount.email}'`,
    ],
    environment,
  );
  process.stdout.write(
    `\nSign in at ${environment.PUBLIC_WEB_ORIGIN ?? 'http://127.0.0.1:5173'} as ${developmentAccount.email} / ${developmentAccount.password}\n\n`,
  );
}

const environment = loadEnvironment();
await run(
  'docker',
  ['compose', 'up', '-d', '--wait', 'postgres', 'redis', 'artifact-store'],
  environment,
);
await run('pnpm', ['exec', 'tsc', '--build', '--pretty', 'false'], environment);
await run('pnpm', ['db:migrate'], environment);

const shutdown = new AbortController();
const apps = [
  start('api', ['--filter', '@pertexo/api', 'dev'], environment),
  start('worker', ['--filter', '@pertexo/worker', 'dev'], environment),
  start('web', ['--filter', '@pertexo/web', 'dev'], environment),
];
const stop = () => {
  shutdown.abort();
  for (const child of apps) child.kill('SIGINT');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
for (const child of apps) child.once('close', stop);

ensureDevelopmentAccount(environment, shutdown.signal).catch((error) => {
  if (!shutdown.signal.aborted)
    process.stderr.write(
      `Development account setup failed: ${error.message}\n`,
    );
});
