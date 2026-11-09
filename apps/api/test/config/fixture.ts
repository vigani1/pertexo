export function validDeployedEnvironment(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
    NODE_ENV: 'production',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test',
    BETTER_AUTH_SECRET: 'better-auth-production-secret-at-least-32-characters',
    AUTH_MAIL_MODE: 'durable',
    AUTH_MAIL_FROM: 'security@example.test',
    AUTH_MAIL_KEY: Buffer.alloc(32, 9).toString('base64'),
    AUTH_MAIL_KEY_VERSION: 'auth-mail-v1',
    INVITATION_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64'),
    INVITATION_TOKEN_KEY_VERSION: 'invite-v1',
    CALLBACK_TOKEN_KEY: Buffer.alloc(32, 71).toString('base64'),
    CALLBACK_TOKEN_KEY_VERSION: 'callback-v1',
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
    CONNECTION_KMS_REGION: 'eu-central-1',
    REDIS_URL: 'rediss://redis.example.test:6380/0',
    TRUST_PROXY_CIDRS: '10.0.0.0/8',
    ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-key',
    ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
    ARTIFACT_STORE_BUCKET: 'pertexo-primary',
    ARTIFACT_STORE_ENDPOINT: 'https://objects-primary.example.test',
    ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
    ARTIFACT_STORE_REGION: 'eu-central-1',
  };
}

export function standaloneBetterAuthEnvironment(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
    BETTER_AUTH_SECRET: 'standalone-better-auth-secret-at-least-32-characters',
    AUTH_MAIL_MODE: 'local',
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
  };
}

export function deployedEnvironmentWithout(
  ...names: readonly string[]
): Record<string, string> {
  const environment = validDeployedEnvironment();
  for (const name of names) Reflect.deleteProperty(environment, name);
  return environment;
}
