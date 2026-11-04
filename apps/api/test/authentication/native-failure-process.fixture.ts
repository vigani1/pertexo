import { createStructuredLogger } from '@pertexo/observability';
import Fastify from 'fastify';
import { createBetterAuthRuntime } from '../../src/authentication/better-auth/better-auth.runtime.js';
import { registerBetterAuthHandler } from '../../src/authentication/better-auth/fastify.js';
import { LocalAuthenticationMailSink } from '../../src/authentication/mail/delivery.js';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

process.once(
  'message',
  (input: { databaseUrl: string; redisUrl: string; email: string }) => {
    void exercise(input).catch(() => {
      process.exitCode = 1;
      process.disconnect();
    });
  },
);

async function exercise(input: {
  databaseUrl: string;
  redisUrl: string;
  email: string;
}) {
  const origin = 'https://app.integration.test';
  const runtime = createBetterAuthRuntime({
    logger: createStructuredLogger({
      serviceName: 'api',
      serviceVersion: 'test',
      environment: 'test',
      logLevel: 'info',
      otlpHeaders: {},
    }),
    baseUrl: origin,
    secret: 'native-output-fixture-secret-at-least-32-characters',
    database: {
      connectionString: input.databaseUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 2,
    },
    secureCookies: false,
    sessionTtlSeconds: 3_600,
    trustedOrigins: [origin],
    signUpMode: 'open',
    mail: new LocalAuthenticationMailSink(),
  });
  const rateLimit = new RedisRateLimitRuntime(input.redisUrl);
  const app = Fastify();
  try {
    registerBetterAuthHandler(app, {
      handler: runtime.auth.handler,
      publicOrigin: origin,
      rateLimitConsumer: rateLimit,
      sessionCookie: { secure: false, sameSite: 'lax', maxAgeSeconds: 3_600 },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      headers: { origin },
      payload: { email: input.email, redirectTo: '/reset-password' },
    });
    process.send?.({
      status: response.statusCode,
      body: response.json(),
      requestId: response.headers['x-request-id'],
    });
  } finally {
    await app.close();
    await runtime.close();
    await rateLimit.close();
    process.disconnect();
  }
}
