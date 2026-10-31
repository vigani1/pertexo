import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
import { parseApiConfig } from '../../src/platform/config/api.js';
import { standaloneBetterAuthEnvironment } from './fixture.js';

export function registerSecuresCookiesOnHTTPSOrigin(): void {
  it('secures cookies on an HTTPS origin', () => {
    const config = parseApiConfig({
      ...standaloneBetterAuthEnvironment(),
      SESSION_COOKIE_SAME_SITE: 'none',
    });

    expect(config.identity).toEqual({
      publicWebOrigin: 'https://app.example.test',
      automationTokensEnabled: false,
      session: {
        ttlMillis: 24 * 60 * 60_000,
        secureCookie: true,
        sameSite: 'none',
      },
      betterAuth: {
        secret: 'standalone-better-auth-secret-at-least-32-characters',
        mailMode: 'local',
        signUpMode: 'invitation',
        printLocalMailLinks: true,
        providers: {},
      },
    });
  });

  it.each([
    ['local mail in development', {}, true],
    ['local mail in tests', { NODE_ENV: 'test' }, undefined],
  ])('prints links for %s: %s', (_name, changed, expected) => {
    const config = parseApiConfig({
      ...standaloneBetterAuthEnvironment(),
      ...changed,
    });

    expect(config.identity?.betterAuth.printLocalMailLinks).toBe(expected);
  });

  it('starts from the shared local example environment', () => {
    // Developers copy .env.example to .env and start the API and worker from it.
    const config = parseApiConfig(
      parseEnv(
        readFileSync(
          new URL('../../../../.env.example', import.meta.url),
          'utf8',
        ),
      ),
    );

    expect(config.nodeEnv).toBe('development');
    expect(config.identity?.betterAuth).toMatchObject({
      mailMode: 'local',
      printLocalMailLinks: true,
    });
    expect(config.connections).toMatchObject({ mode: 'self-managed' });
    expect(config.webhooks).toMatchObject({ mode: 'self-managed' });
    expect(config.artifacts?.bucket).toBeDefined();
  });
}
