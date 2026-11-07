import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  standaloneBetterAuthEnvironment,
  validDeployedEnvironment,
} from '../config/fixture.js';

const standalone = standaloneBetterAuthEnvironment();
const deployed = validDeployedEnvironment();
const key = Buffer.alloc(32, 7).toString('base64');

const refusals = [
  {
    name: 'missing authentication secret',
    environment: { ...standalone, BETTER_AUTH_SECRET: undefined },
    settings: ['BETTER_AUTH_SECRET'],
    remedy:
      'set BETTER_AUTH_SECRET to a private secret of at least 32 characters',
  },
  {
    name: 'invitation key without version',
    environment: { ...standalone, INVITATION_TOKEN_KEY: key },
    settings: ['INVITATION_TOKEN_KEY', 'INVITATION_TOKEN_KEY_VERSION'],
    remedy: 'configure both invitation key settings together',
  },
  {
    name: 'invitation version without key',
    environment: {
      ...standalone,
      INVITATION_TOKEN_KEY_VERSION: 'private-invitation-version',
    },
    settings: ['INVITATION_TOKEN_KEY', 'INVITATION_TOKEN_KEY_VERSION'],
    remedy: 'configure both invitation key settings together',
  },
  {
    name: 'missing public origin',
    environment: { ...standalone, PUBLIC_WEB_ORIGIN: undefined },
    settings: ['PUBLIC_WEB_ORIGIN'],
    remedy: 'set PUBLIC_WEB_ORIGIN to the browser application origin',
  },
  {
    name: 'non-HTTPS deployed public origin',
    environment: {
      ...deployed,
      PUBLIC_WEB_ORIGIN: 'http://private-origin.example.test',
    },
    settings: ['PUBLIC_WEB_ORIGIN'],
    remedy: 'use an HTTPS public web origin when deployed',
  },
  {
    name: 'secure cookie on an HTTP origin',
    environment: {
      ...standalone,
      PUBLIC_WEB_ORIGIN: 'http://private-origin.example.test',
      SESSION_COOKIE_SECURE: 'true',
    },
    settings: ['PUBLIC_WEB_ORIGIN', 'SESSION_COOKIE_SECURE'],
    remedy: 'use an HTTPS public web origin for secure session cookies',
  },
  {
    name: 'insecure deployed cookie',
    environment: { ...deployed, SESSION_COOKIE_SECURE: 'false' },
    settings: ['SESSION_COOKIE_SECURE'],
    remedy: 'enable secure session cookies when deployed',
  },
  {
    name: 'cross-site cookie without secure flag',
    environment: {
      ...standalone,
      PUBLIC_WEB_ORIGIN: 'http://private-origin.example.test',
      SESSION_COOKIE_SAME_SITE: 'none',
      SESSION_COOKIE_SECURE: 'false',
    },
    settings: ['SESSION_COOKIE_SAME_SITE', 'SESSION_COOKIE_SECURE'],
    remedy:
      'enable secure session cookies or select a different same-site policy',
  },
  {
    name: 'public origin with a path',
    environment: {
      ...standalone,
      PUBLIC_WEB_ORIGIN: 'https://private-origin.example.test/private-path',
    },
    settings: ['PUBLIC_WEB_ORIGIN'],
    remedy: 'use an origin without a path, query or fragment',
  },
  {
    name: 'non-durable deployed authentication mail',
    environment: { ...deployed, AUTH_MAIL_MODE: 'local' },
    settings: ['AUTH_MAIL_MODE'],
    remedy: 'configure durable authentication mail when deployed',
  },
  {
    name: 'missing deployed Redis URL',
    environment: { ...deployed, REDIS_URL: undefined },
    settings: ['REDIS_URL'],
    remedy: 'configure a Redis connection URL when deployed',
  },
  {
    name: 'missing deployed trusted proxies',
    environment: { ...deployed, TRUST_PROXY_CIDRS: undefined },
    settings: ['TRUST_PROXY_CIDRS'],
    remedy: 'configure the trusted proxy IP addresses or CIDRs when deployed',
  },
  {
    name: 'invalid local connection key',
    environment: {
      ...standalone,
      CONNECTION_ENCRYPTION_MODE: 'local',
      CONNECTION_LOCAL_KEY: 'private-invalid-connection-key',
    },
    settings: ['CONNECTION_ENCRYPTION_MODE', 'CONNECTION_LOCAL_KEY'],
    remedy:
      'select one connection encryption mode and configure its matching keys or KMS settings',
  },
  {
    name: 'incomplete KMS settings',
    environment: {
      ...standalone,
      CONNECTION_ENCRYPTION_MODE: 'kms',
      CONNECTION_KMS_KEY_REFERENCE: 'private-kms-reference',
    },
    settings: ['CONNECTION_KMS_KEY_REFERENCE', 'CONNECTION_KMS_REGION'],
    remedy:
      'select one connection encryption mode and configure its matching keys or KMS settings',
  },
  {
    name: 'callback key without version',
    environment: { ...standalone, CALLBACK_TOKEN_KEY: key },
    settings: ['CALLBACK_TOKEN_KEY', 'CALLBACK_TOKEN_KEY_VERSION'],
    remedy: 'configure matching callback key settings and a public web origin',
  },
  {
    name: 'invalid private-network entry',
    environment: {
      ...standalone,
      HTTP_ALLOWED_PRIVATE_NETWORKS: 'private-invalid-network',
    },
    settings: ['HTTP_ALLOWED_PRIVATE_NETWORKS'],
    remedy: 'use comma-separated IPv4 or IPv6 CIDRs',
  },
];

describe('owned startup refusals through the real API process', () => {
  it.each(refusals)(
    '$name names its settings and remedy without echoing input',
    ({ environment, settings, remedy }) => {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../../src/main.ts', import.meta.url)),
        ],
        {
          env: { PATH: process.env.PATH, NODE_ENV: 'test', ...environment },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('api.process_failed');
      for (const setting of settings) expect(result.stderr).toContain(setting);
      expect(result.stderr).toContain(remedy);
      for (const text of [result.stdout, result.stderr]) {
        expect(text).not.toContain('private-');
        expect(text).not.toContain('[Redacted]');
        for (const [name, value] of Object.entries(environment)) {
          if (
            value !== undefined &&
            (name.endsWith('_KEY') ||
              name.endsWith('_SECRET') ||
              name === 'PUBLIC_WEB_ORIGIN')
          )
            expect(text).not.toContain(value);
        }
      }
    },
  );
});
