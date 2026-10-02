import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Test-owned process adapter, deliberately using the compiled full API app and
// the established Better Auth real fixture composition (not a parallel auth).
const [source, apiUrl, redisUrl] = process.argv.slice(2);
const databaseUrl = new URL(apiUrl),
  redis = new URL(redisUrl);
if (
  databaseUrl.hostname !== '127.0.0.1' ||
  databaseUrl.port !== '55438' ||
  !/^\/pertexo_test_f06_cutover_[a-f0-9]{24}$/u.test(databaseUrl.pathname) ||
  redis.hostname !== '127.0.0.1' ||
  redis.port !== '56382' ||
  redis.pathname !== '/12'
)
  throw new Error('Cutover child refuses non-owned resources');
const require = createRequire(path.join(source, 'apps/api/package.json'));
const load = async (specifier) =>
  import(pathToFileURL(require.resolve(specifier)).href);
const local = async (filename) =>
  import(pathToFileURL(path.join(source, 'apps/api/dist', filename)).href);
await load('reflect-metadata');
const [
  { createApiApplication },
  { createApiIdentityRuntime },
  { LocalAuthenticationMailSink },
  { createCoreWorkflowCompatibility },
  { ApiDrainState },
  databaseModule,
  { RedisRateLimitRuntime },
  { bootstrapApi },
] = await Promise.all([
  local('app.js'),
  local('platform/identity/identity-runtime.module.js'),
  local('identity-infrastructure/index.js'),
  local('platform/workflow/workflow-compatibility.js'),
  local('platform/health/drain-state.js'),
  load('@pertexo/database/testing'),
  load('@pertexo/rate-limit'),
  local('main.js'),
]);
const config = {
  database: databaseModule.parseDatabaseConfig({
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
    serviceName: 'pertexo-cutover-api',
    serviceVersion: 'owned-source-artifact',
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
const mail = new LocalAuthenticationMailSink();
const resources = [];
let app, closing;
async function close() {
  closing ??= (async () => {
    const failures = [];
    for (const resource of resources.toReversed())
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, 'Cutover API process cleanup failed');
  })();
  return closing;
}
try {
  const identityRuntime = await createApiIdentityRuntime(
    config.identity,
    config.database,
    { authenticationMail: mail },
  );
  resources.push(identityRuntime);
  const database = databaseModule.createWorkspaceDatabase(config.database, {
    compatibilityReleases: createCoreWorkflowCompatibility(
      'validate_activation',
    ).readinessSupport.descriptions,
  });
  resources.push(database);
  const limiter = new RedisRateLimitRuntime(redisUrl);
  resources.push(limiter);
  const namespace = randomUUID();
  const dependencies = {
    database,
    identityRuntime,
    logger,
    telemetry,
    rateLimitConsumer: {
      consume: (decision) =>
        limiter.consume({
          ...decision,
          dimensions: decision.dimensions.map((dimension) => ({
            ...dimension,
            identifier: `${namespace}:${dimension.identifier}`,
          })),
        }),
    },
  };
  await bootstrapApi({
    config,
    createTelemetryLifecycle: () => telemetry,
    loadModules: async () => ({
      logging: { createStructuredLogger: () => logger },
      application: {
        createApiApplication: async (configuration, bootstrapDependencies) => {
          app = await createApiApplication(configuration, {
            ...bootstrapDependencies,
            ...dependencies,
          });
          resources.push({ close: () => app.close() });
          return app;
        },
      },
    }),
  });
  process.send?.({
    phase: 'listening',
    url: await app.getUrl(),
    pid: process.pid,
    namespace,
  });
  process.on('message', (message) => {
    void (async () => {
      if (message.operation === 'mail')
        return mail
          .readForTesting(message.email)
          .map(({ purpose, url }) => ({ purpose, url }));
      if (message.operation === 'drain') {
        app.get(ApiDrainState).beginDrain();
        return { draining: true };
      }
      if (message.operation === 'close') {
        await close();
        return { closed: true };
      }
      throw new Error('Unsupported cutover control');
    })().then(
      (result) => {
        process.send?.({ id: message.id, result });
        if (message.operation === 'close') process.disconnect();
      },
      async (error) => {
        process.send?.({ id: message.id, error: error.message });
        await close().catch(() => undefined);
        process.exitCode = 1;
        process.disconnect();
      },
    );
  });
} catch (error) {
  await close().catch(() => undefined);
  process.send?.({ phase: 'startup-failed', error: error.message });
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
