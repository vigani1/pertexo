import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { withUpgradeDatabase } from './upgrade-fixture.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));

it('runs the production verifier against an empty upgraded install and refuses development keys and insecure origins', async () => {
  await withUpgradeDatabase(91, async ({ config }) => {
    const url = (base: string) => {
      const value = new URL(base);
      value.pathname = new URL(config.connectionString).pathname;
      return value.toString();
    };
    const environment = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: url(process.env.DATABASE_URL ?? ''),
      DATABASE_MAINTENANCE_URL: url(process.env.DATABASE_MAINTENANCE_URL ?? ''),
      CONNECTION_ENCRYPTION_MODE: 'self-managed',
      CONNECTION_SELF_MANAGED_KEY_VERSION: 'production-v1',
      CONNECTION_SELF_MANAGED_KEY: randomBytes(32).toString('base64'),
      CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: '[]',
      CALLBACK_TOKEN_KEY: randomBytes(32).toString('base64'),
      CALLBACK_TOKEN_KEY_VERSION: 'production-v1',
      CALLBACK_TOKEN_PREVIOUS_KEYS: '[]',
      PUBLIC_WEB_ORIGIN: 'https://app.example.test',
      AWS_ENDPOINT_URL: '',
    };
    const verify = async (overrides: Record<string, string | undefined>) => {
      try {
        return {
          code: 0,
          ...(await run(
            process.execPath,
            ['infrastructure/single-server/encryption/verify.mjs'],
            {
              cwd: root,
              env: { ...environment, ...overrides },
              timeout: 15_000,
            },
          )),
        };
      } catch (error) {
        const failure = error as Error & {
          code: number;
          stdout: string;
          stderr: string;
        };
        return {
          code: failure.code,
          stdout: failure.stdout,
          stderr: failure.stderr,
        };
      }
    };
    const valid = await verify({});
    expect(valid.code, valid.stderr).toBe(0);
    expect(valid.stdout).toContain('encryption.verified');
    for (const overrides of [
      {
        CONNECTION_ENCRYPTION_MODE: 'local',
        CONNECTION_LOCAL_KEY: environment.CONNECTION_SELF_MANAGED_KEY,
        CONNECTION_SELF_MANAGED_KEY: undefined,
        CONNECTION_SELF_MANAGED_KEY_VERSION: undefined,
        CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: undefined,
      },
      { CALLBACK_TOKEN_KEY: Buffer.from('F'.repeat(32)).toString('base64') },
      { CALLBACK_TOKEN_KEY: undefined },
      { PUBLIC_WEB_ORIGIN: 'http://app.example.test' },
      {
        CONNECTION_ENCRYPTION_MODE: 'kms',
        CONNECTION_SELF_MANAGED_KEY: undefined,
        CONNECTION_SELF_MANAGED_KEY_VERSION: undefined,
        CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: undefined,
        CONNECTION_KMS_KEY_REFERENCE: 'alias/synthetic',
        CONNECTION_KMS_REGION: 'us-east-1',
        CONNECTION_KMS_ENDPOINT: 'http://kms.example.test',
      },
    ]) {
      const failed = await verify(overrides);
      expect(failed.code, JSON.stringify(overrides)).not.toBe(0);
      expect(failed.stderr).toContain('encryption.verification_failed');
      expect(failed.stderr).not.toContain(
        environment.CONNECTION_SELF_MANAGED_KEY,
      );
      expect(failed.stderr).not.toContain(environment.CALLBACK_TOKEN_KEY);
      expect(failed.stderr).not.toMatch(/postgresql:\/\//u);
    }
  });
});
