import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createDatabaseWithInheritedAppSetting } from '@pertexo/database/testing';
import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(
  new URL('../../dist/main.js', import.meta.url),
);
const BOOT_TIMEOUT_MILLIS = 60_000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

/** Boots the built API and returns what it printed and how it exited. */
function bootApi(
  databaseUrl: (base: string) => string,
): Promise<{ code: number | null; lines: Record<string, unknown>[] }> {
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl(required('DATABASE_URL')),
      DATABASE_MIGRATION_URL: databaseUrl(required('DATABASE_MIGRATION_URL')),
      DATABASE_MAINTENANCE_URL: databaseUrl(
        required('DATABASE_MAINTENANCE_URL'),
      ),
      HOST: '127.0.0.1',
      PORT: '47310',
      PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:47311',
      BETTER_AUTH_SECRET:
        'pertexo-local-better-auth-secret-change-before-deployment',
      AUTH_MAIL_MODE: 'local',
      AUTH_SIGN_UP_MODE: 'invitation',
      AUTOMATION_TOKENS_ENABLED: 'true',
      WORKSPACE_ACTIVE_RUN_LIMIT: '20',
      WORKSPACE_QUEUED_RUN_LIMIT: '10000',
      WORKSPACE_FILE_LIMIT: '10000',
      WEBHOOK_ENDPOINT_BURST_LIMIT: '600',
      CALLBACK_TOKEN_KEY: 'RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkY',
      CALLBACK_TOKEN_KEY_VERSION: 'v1',
      CONNECTION_ENCRYPTION_MODE: 'self-managed',
      CONNECTION_SELF_MANAGED_KEY:
        'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      CONNECTION_SELF_MANAGED_KEY_VERSION: 'local:development',
      ARTIFACT_MAX_BYTES: '10485760',
      SERVICE_VERSION: '0.0.0-test',
      LOG_LEVEL: 'info',
      CODE_STEPS_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The API did not stop: ${output}`));
    }, BOOT_TIMEOUT_MILLIS);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        lines: output
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      });
    });
  });
}

describe.runIf(process.env.DATABASE_ADMIN_URL !== undefined)(
  'an API whose database role inherits an app setting',
  () => {
    it(
      'refuses to start and tells the operator which setting and where it comes from',
      async () => {
        const value = randomUUID();
        const database = await createDatabaseWithInheritedAppSetting({
          adminUrl: required('DATABASE_ADMIN_URL'),
          migrationUrl: required('DATABASE_MIGRATION_URL'),
          setting: 'app.workspace_id',
          value,
        });
        try {
          const { code, lines } = await bootApi(database.databaseUrl);

          expect(code).toBe(1);
          expect(lines.some((line) => line.event === 'api.started')).toBe(
            false,
          );
          const failure = lines.find(
            (line) => line.event === 'api.process_failed',
          );
          const cause = String(failure?.cause);
          expect(cause).toContain(
            'refused a connection that already carries app.workspace_id',
          );
          expect(cause).toContain('the role or database defaults');
          expect(JSON.stringify(lines)).not.toContain(value);
        } finally {
          await database.drop();
        }
      },
      BOOT_TIMEOUT_MILLIS + 60_000,
    );
  },
);
