import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { standaloneBetterAuthEnvironment } from '../config/fixture.js';

describe('identity startup diagnostics in the actual API process', () => {
  it.each([
    [
      'AUTH_GOOGLE_CLIENT_SECRET',
      { AUTH_GOOGLE_CLIENT_SECRET: 'private-provider-secret' },
      'supply both settings or remove both',
    ],
    [
      'AUTH_FEDERATION_KEY',
      {
        AUTH_FEDERATION_KEY: 'private-federation-key',
        AUTH_FEDERATION_KEY_VERSION: 'private-key-version',
      },
      'supply matching settings and valid keys',
    ],
    [
      'AUTH_MAIL_PREVIOUS_KEYS',
      {
        AUTH_MAIL_MODE: 'durable',
        AUTH_MAIL_FROM: 'private-sender@example.test',
        AUTH_MAIL_KEY: 'private-mail-key',
        AUTH_MAIL_KEY_VERSION: 'private-key-version',
        AUTH_MAIL_PREVIOUS_KEYS: '{private-key-json',
      },
      'supply matching settings and valid keys',
    ],
    [
      'INVITATION_TOKEN_PREVIOUS_KEYS',
      {
        INVITATION_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
        INVITATION_TOKEN_KEY_VERSION: 'private-key-version',
        INVITATION_TOKEN_PREVIOUS_KEYS: '{private-invitation-json',
      },
      'supply matching settings and valid keys',
    ],
  ] as const)(
    'names %s and a remedy without leaking rejected values',
    (setting, changes, remedy) => {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../../src/main.ts', import.meta.url)),
        ],
        {
          env: {
            PATH: process.env.PATH,
            ...standaloneBetterAuthEnvironment(),
            NODE_ENV: 'test',
            ...changes,
          },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(setting);
      expect(result.stderr).toContain(remedy);
      expect(result.stderr).toContain('api.process_failed');
      for (const text of [result.stdout, result.stderr]) {
        expect(text).not.toContain('private-');
        expect(text).not.toContain('standalone-better-auth-secret');
        expect(text).not.toContain(Buffer.alloc(32, 7).toString('base64'));
        expect(text).not.toContain('SyntaxError');
      }
    },
  );
});
