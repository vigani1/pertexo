import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { requiredEnvironment } from './worker-environment.fixture.js';

const key = Buffer.alloc(32, 4).toString('base64');
const secret = 'private-mail-provider-credential';
const mail = {
  AUTH_MAIL_KEY: key,
  AUTH_MAIL_KEY_VERSION: 'v1',
  AUTH_MAIL_EMAIL_API_KEY: secret,
  AUTH_MAIL_FROM: 'security@example.test',
  INVITATION_TOKEN_KEY: key,
  INVITATION_TOKEN_KEY_VERSION: 'v1',
  INVITATION_EMAIL_API_KEY: secret,
  INVITATION_EMAIL_FROM: 'invite@example.test',
  PUBLIC_WEB_ORIGIN: 'http://localhost',
};
it.each([
  ['AUTH_MAIL_KEY_VERSION', 'private invalid version', /version.*letters/i],
  [
    'INVITATION_TOKEN_KEY_VERSION',
    'private invalid version',
    /version.*letters/i,
  ],
  ['AUTH_MAIL_FROM', 'private-invalid-address', /email address/i],
  ['INVITATION_EMAIL_FROM', 'private-invalid-address', /email address/i],
  ['PUBLIC_WEB_ORIGIN', 'private-invalid-origin', /HTTP\(S\) origin/i],
  ['AUTH_MAIL_PREVIOUS_KEYS', 'private-invalid-json', /JSON array/i],
  ['INVITATION_TOKEN_PREVIOUS_KEYS', 'private-invalid-json', /JSON array/i],
  ['AUTH_MAIL_EMAIL_TIMEOUT_MILLIS', 'private-invalid-timeout', /100.*30000/],
  ['INVITATION_EMAIL_TIMEOUT_MILLIS', 'private-invalid-timeout', /100.*30000/],
  ['AUTH_MAIL_EMAIL_API_KEY', '', /API key/i],
] as const)(
  'compiled worker names %s and its remedy without rejected values',
  (setting, raw, remedy) => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../dist/main.js', import.meta.url))],
      {
        env: {
          PATH: process.env.PATH,
          ...requiredEnvironment,
          NODE_ENV: 'test',
          ...mail,
          [setting]: raw,
        },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 65536,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(setting);
    expect(child.stderr).toMatch(remedy);
    for (const value of [key, secret, 'secret@localhost', raw].filter(Boolean))
      expect(child.stderr).not.toContain(value);
  },
);

it.each([
  ['SYSTEM_MAIL_TRANSPORT', 'private-transport', /resend or smtp/],
  ['SYSTEM_MAIL_SMTP_HOST', 'private invalid host', /SMTP hostname/],
  ['SYSTEM_MAIL_SMTP_PORT', 'private-port', /1 to 65535/],
  ['SYSTEM_MAIL_SMTP_TLS', 'private-tls', /starttls or implicit/],
  ['SYSTEM_MAIL_SMTP_PASSWORD', undefined, /username and password together/],
] as const)(
  'compiled worker names transport setting %s without rejected values',
  (setting, raw, remedy) => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../dist/main.js', import.meta.url))],
      {
        env: {
          PATH: process.env.PATH,
          ...requiredEnvironment,
          NODE_ENV: 'test',
          ...mail,
          SYSTEM_MAIL_TRANSPORT: 'smtp',
          SYSTEM_MAIL_SMTP_HOST: '127.0.0.1',
          SYSTEM_MAIL_SMTP_PORT: '2525',
          SYSTEM_MAIL_SMTP_TLS: 'starttls',
          SYSTEM_MAIL_SMTP_USER: 'private-smtp-user',
          SYSTEM_MAIL_SMTP_PASSWORD: secret,
          [setting]: raw,
        },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 65536,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(setting);
    expect(child.stderr).toMatch(remedy);
    for (const value of [key, secret, 'private-smtp-user', raw].filter(Boolean))
      expect(child.stderr).not.toContain(value);
  },
);
