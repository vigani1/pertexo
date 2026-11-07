import { createStructuredLogger } from '@pertexo/observability/server';
import {
  createWorkspaceDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/platform';
import { createApiIdentityRuntime } from '../../dist/platform/identity/identity-runtime.module.js';
import { LocalAuthenticationMailSink } from '../../src/authentication/mail/authentication-mail.js';
import { assembleApiApplication } from '../../dist/app.js';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit/server';
import { apiConfig } from '../support/better-auth/api/configuration.js';
import {
  password,
  telemetry,
  origin,
} from '../support/better-auth/api/environment.js';

type FailureRequest = Readonly<{
  databaseUrl: string;
  redisUrl: string;
  email: string;
  mode: 'session_lookup' | 'sign_up';
  cookie?: string;
}>;

process.once('message', (input: FailureRequest) => {
  void exercise(input).catch(() => {
    process.exitCode = 1;
    process.disconnect();
  });
});

async function exercise(input: FailureRequest) {
  const databaseConfig = parseDatabaseConfig({
    connectionString: input.databaseUrl,
    max: 2,
  });
  const config = { ...apiConfig(databaseConfig), redisUrl: input.redisUrl };
  if (config.identity === undefined)
    throw new Error('Identity fixture missing');
  const logger = createStructuredLogger({
    serviceName: 'api',
    serviceVersion: 'test',
    environment: 'test',
    logLevel: 'info',
    otlpHeaders: {},
  });
  const database = createWorkspaceDatabase(databaseConfig);
  const identityRuntime = await createApiIdentityRuntime(
    config.identity,
    databaseConfig,
    { logger, authenticationMail: new LocalAuthenticationMailSink() },
  );
  const rateLimit = new RedisRateLimitRuntime(input.redisUrl);
  let app: Awaited<ReturnType<typeof assembleApiApplication>> | undefined;
  try {
    app = await assembleApiApplication(
      config,
      { logger, telemetry },
      { database, identityRuntime, rateLimit },
    );
    await app.init();
    const session = input.mode === 'session_lookup';
    const response = await app.inject({
      method: session ? 'GET' : 'POST',
      url: session ? '/v1/users/me' : '/v1/auth/sign-up/email',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-request-id': `native-${input.mode}`,
        ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
      },
      ...(session
        ? {}
        : {
            payload: JSON.stringify({
              email: input.email,
              password,
              name: 'Owner',
              callbackURL: '/login?verified=true',
            }),
          }),
    });
    process.send?.({
      status: response.statusCode,
      body: response.json<unknown>(),
      requestId: response.headers['x-request-id'],
    });
  } finally {
    await app?.close();
    await identityRuntime.close();
    await database.close();
    await rateLimit.close();
    process.disconnect();
  }
}
