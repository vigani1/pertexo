import { randomUUID } from 'node:crypto';
import { workspaceInvitationCreateRequestSchema } from '@pertexo/contracts';
import { EMAIL_ADDRESS_LIMITS } from '@pertexo/workflow-model';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerBetterAuthHandler } from '../../src/authentication/better-auth/better-auth-transport.js';
import { createEmailLengthPlugin } from '../../src/authentication/better-auth/email-length-plugin.js';
import {
  allowingRateLimit,
  applications,
  cleanBetterAuthFastifyBridgeFixture,
} from './better-auth-transport.fixture.js';

/** A syntactically valid address exactly `length` characters long. */
function addressOf(length: number): string {
  const domain = '.test';
  const local = 'a'.repeat(64);
  let middle = '';
  while (local.length + 1 + middle.length + domain.length < length) {
    const label = 'b'.repeat(
      Math.min(
        63,
        length - local.length - 1 - domain.length - middle.length - 1,
      ),
    );
    middle = middle === '' ? label : `${middle}.${label}`;
  }
  return `${local}@${middle}${domain}`;
}

const longest = addressOf(EMAIL_ADDRESS_LIMITS.characters);
const tooLong = addressOf(EMAIL_ADDRESS_LIMITS.characters + 1);

function application() {
  const auth = betterAuth({
    appName: 'Pertexo',
    baseURL: 'https://pertexo.test',
    basePath: '/v1/auth',
    secret: 'email-length-proof-secret-with-at-least-32-characters',
    database: memoryAdapter({
      user: [],
      account: [],
      session: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    user: {
      changeEmail: { enabled: true, updateEmailWithoutVerification: true },
    },
    plugins: [createEmailLengthPlugin()],
    advanced: { database: { generateId: () => randomUUID() } },
    telemetry: { enabled: false },
  });
  const server = Fastify();
  applications.push(server);
  registerBetterAuthHandler(server, {
    handler: auth.handler,
    rateLimitConsumer: allowingRateLimit,
    publicOrigin: 'https://pertexo.test',
    sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3_600 },
  });
  return server;
}

const origin = { origin: 'https://pertexo.test' };
const signUp = (server: ReturnType<typeof application>, email: string) =>
  server.inject({
    method: 'POST',
    url: '/v1/auth/sign-up/email',
    headers: origin,
    payload: { name: 'Ada', email, password: 'correct horse battery staple' },
  });

afterEach(cleanBetterAuthFastifyBridgeFixture);

describe('email addresses at the boundary', () => {
  it('builds addresses of the lengths under test', () => {
    expect(longest).toHaveLength(254);
    expect(tooLong).toHaveLength(255);
  });

  it('signs up with a 254-character address and refuses 255', async () => {
    const server = application();
    expect((await signUp(server, longest)).statusCode).toBe(200);
    const refused = await signUp(server, tooLong);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'request.invalid' });
  });

  it('changes an account email to 254 characters and refuses 255', async () => {
    const server = application();
    const created = await signUp(server, 'ada@example.test');
    const cookie = ([] as string[])
      .concat(created.headers['set-cookie'] ?? [])
      .map((value) => value.split(';')[0])
      .join('; ');
    const change = (newEmail: string) =>
      server.inject({
        method: 'POST',
        url: '/v1/auth/change-email',
        headers: { ...origin, cookie },
        payload: { newEmail },
      });
    const refused = await change(tooLong);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'request.invalid' });
    expect((await change(longest)).statusCode).toBe(200);
  });

  it('refuses inviting a 255-character address', () => {
    const invite = (email: string) =>
      workspaceInvitationCreateRequestSchema.safeParse({
        email,
        role: 'builder',
      }).success;
    expect(invite(longest)).toBe(true);
    expect(invite(tooLong)).toBe(false);
  });
});
