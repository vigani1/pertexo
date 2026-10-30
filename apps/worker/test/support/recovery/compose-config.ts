import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';

import { repositoryRoot } from './environment.js';

const execFileAsync = promisify(execFile);

type ResolvedService = Readonly<{
  healthcheck?: Readonly<{ test?: readonly string[]; timeout?: string }>;
  image: string;
  init?: boolean;
  stop_grace_period?: string;
}>;

export type ComposeServiceSettings = Readonly<{
  healthcheckCommand: string;
  healthcheckTimeoutMs: number;
  image: string;
  init: boolean;
  stopGracePeriodMs: number;
}>;

/** Compose prints durations like `1m0s`, `3s` or `1m30s`. */
function durationMs(value: string | undefined): number {
  if (value === undefined) return 0;
  const minutes = /(\d+)m/u.exec(value)?.[1] ?? '0';
  const seconds = /(\d+)s/u.exec(value)?.[1] ?? '0';
  return (Number(minutes) * 60 + Number(seconds)) * 1_000;
}

async function resolve(
  file: string,
  service: string,
  environment: NodeJS.ProcessEnv,
): Promise<ComposeServiceSettings> {
  const { stdout } = await execFileAsync(
    'docker',
    [
      'compose',
      '--env-file',
      '/dev/null',
      '-f',
      file,
      'config',
      '--format',
      'json',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const config = JSON.parse(stdout) as {
    services: Record<string, ResolvedService>;
  };
  const resolved = config.services[service];
  if (resolved === undefined)
    throw new Error(`${file} has no ${service} service`);
  return {
    healthcheckCommand: (resolved.healthcheck?.test ?? []).join(' '),
    healthcheckTimeoutMs: durationMs(resolved.healthcheck?.timeout),
    image: resolved.image,
    init: resolved.init === true,
    stopGracePeriodMs: durationMs(resolved.stop_grace_period),
  };
}

/** A service as `docker compose config` resolves it from the development file. */
export function developmentService(
  service: string,
): Promise<ComposeServiceSettings> {
  return resolve('compose.yaml', service, process.env);
}

/** A service as `docker compose config` resolves it from the production file. */
export async function productionService(
  service: string,
): Promise<ComposeServiceSettings> {
  const generated = await execFileAsync(
    process.execPath,
    ['infrastructure/single-server/generate-secrets.mjs', '--encryption=kms'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  const example = await readFile(
    `${repositoryRoot}infrastructure/single-server/.env.production.example`,
    'utf8',
  );
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-compose-'));
  try {
    const environment = {
      ...process.env,
      ...parseEnv(example),
      ...parseEnv(generated.stdout),
      ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
      AUTH_MAIL_EMAIL_API_KEY: 'fixture-mail',
      AUTH_MAIL_FROM: 'security@example.test',
      AWS_ACCESS_KEY_ID: 'fixture-kms',
      AWS_SECRET_ACCESS_KEY: 'fixture-kms-secret',
      BETA_STATE_DIR: directory,
      CONNECTION_KMS_KEY_REFERENCE: 'alias/fixture',
      CONNECTION_KMS_REGION: 'eu-central-1',
      INVITATION_EMAIL_API_KEY: 'fixture-mail',
      INVITATION_EMAIL_FROM: 'invites@example.test',
      PUBLIC_WEB_ORIGIN: 'https://app.example.test',
      SERVICE_VERSION: 'b'.repeat(40),
    };
    await execFileAsync(
      process.execPath,
      ['infrastructure/single-server/storage/prepare.mjs', directory],
      { cwd: repositoryRoot, env: environment },
    );
    const hosts = parseEnv(
      await readFile(join(directory, 'hosts.env'), 'utf8'),
    );
    return await resolve('infrastructure/single-server/compose.yaml', service, {
      ...environment,
      ...hosts,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
