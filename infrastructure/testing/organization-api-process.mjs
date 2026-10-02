import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { organizationStartupFailure } from './organization-process-protocol.mjs';
import {
  curatedDatabaseUrl,
  curatedRedisUrl,
  verifyCuratedFixtureOwnership,
} from './curated-template-owned-fixture.mjs';

// Test composition only: all application code is the unchanged compiled artifact.
const [source] = process.argv.slice(2);
let app;
let closing;
const close = () => (closing ??= Promise.resolve().then(() => app?.close()));
try {
  const owned = await verifyCuratedFixtureOwnership();
  const apiUrl = process.env.F07_PROCESS_API_URL;
  const redisUrl = process.env.F07_PROCESS_REDIS_URL;
  const name = new URL(apiUrl).pathname.slice(1);
  if (
    curatedDatabaseUrl(owned.apiUrl, name) !== apiUrl ||
    curatedRedisUrl(owned.redisUrl, 12) !== redisUrl
  )
    throw new Error('Owned resource mismatch');
  const require = createRequire(path.join(source, 'apps/api/package.json'));
  const load = (specifier) =>
    import(pathToFileURL(require.resolve(specifier)).href);
  const local = (filename) =>
    import(pathToFileURL(path.join(source, 'apps/api/dist', filename)).href);
  await load('reflect-metadata');
  const [
    { createApiApplication },
    { LocalAuthenticationMailSink },
    { parseDatabaseConfig },
  ] = await Promise.all([
    local('app.js'),
    local('identity-infrastructure/index.js'),
    load('@pertexo/database/testing'),
  ]);
  const mail = new LocalAuthenticationMailSink();
  const config = {
    database: parseDatabaseConfig({
      connectionString: apiUrl,
      max: 4,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 3000,
      ownerRole: 'pertexo_owner',
    }),
    host: '127.0.0.1',
    port: 0,
    nodeEnv: 'test',
    nodeCompatibilityCohort: 'validate_activation',
    redisUrl,
    workflowOrganization: {
      cursorSigningKey: Buffer.alloc(32, 0x7a).toString('base64'),
    },
    identity: {
      publicWebOrigin: 'https://app.integration.test',
      invitationTokenEncryption: {
        current: {
          version: 'invite-v1',
          key: Buffer.alloc(32, 0x3c).toString('base64'),
        },
        previous: [],
      },
      session: { ttlMillis: 3600000, secureCookie: false, sameSite: 'lax' },
      betterAuth: {
        secret: 'better-auth-only-integration-secret-with-32-plus-characters',
        mailMode: 'local',
        providers: {},
      },
    },
    observability: {
      environment: 'test',
      logLevel: 'silent',
      otlpHeaders: {},
      serviceName: 'pertexo-f07-owned-api',
      serviceVersion: 'frozen-source-artifact',
    },
  };
  const logger = Object.fromEntries(
    ['debug', 'error', 'fatal', 'info', 'trace', 'warn'].map((key) => [
      key,
      () => undefined,
    ]),
  );
  const telemetry = {
    enabled: false,
    started: false,
    start: () => undefined,
    shutdown: () => Promise.resolve(),
  };
  app = await createApiApplication(config, {
    logger,
    telemetry,
    identityOverrides: { authenticationMail: mail },
  });
  await app.listen(0, '127.0.0.1');
  const port = Number(new URL(await app.getUrl()).port);
  process.send?.({ phase: 'listening', pid: process.pid, port });
  process.on('message', (message) => {
    if (!message || typeof message.id !== 'string') return;
    void (async () => {
      if (
        message.operation === 'verify-email' &&
        typeof message.email === 'string'
      ) {
        const verification = mail
          .readForTesting(message.email)
          .find((item) => item.purpose === 'verification');
        if (!verification) throw new Error('Verification mail missing');
        const privateUrl = new URL(verification.url);
        const response = await fetch(
          `http://127.0.0.1:${port}${privateUrl.pathname}${privateUrl.search}`,
          { redirect: 'manual', signal: AbortSignal.timeout(10000) },
        );
        return { status: response.status };
      }
      if (message.operation === 'close') {
        await close();
        return { closed: true };
      }
      throw new Error('Unsupported control');
    })().then(
      (result) => {
        process.send?.({ id: message.id, result });
        if (message.operation === 'close') process.disconnect();
      },
      () => process.send?.({ id: message.id, failed: true }),
    );
  });
} catch (error) {
  await close().catch(() => undefined);
  // Never forward transport/config/error strings, which may contain credentials.
  const reason = organizationStartupFailure(error);
  process.send?.({ phase: 'refused', reason });
  process.exitCode = 1;
  process.disconnect?.();
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    void close().then(
      () => {
        process.exitCode = 0;
        process.disconnect?.();
      },
      () => {
        process.exitCode = 1;
        process.disconnect?.();
      },
    );
  });
