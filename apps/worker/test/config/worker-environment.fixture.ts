export const databaseEnvironment = {
  DATABASE_MAINTENANCE_URL:
    'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
  DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
  REDIS_URL: 'redis://:secret@localhost:6379/0',
} as const;

export const requiredEnvironment = {
  ...databaseEnvironment,
  ARTIFACT_SCRATCH_DIRECTORY: '/var/lib/pertexo/artifact-scratch',
  ARTIFACT_STORE_ACCESS_KEY_ID: 'local-access',
  ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
  ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
  ARTIFACT_STORE_REGION: 'us-east-1',
  ARTIFACT_STORE_SECRET_ACCESS_KEY: 'local-secret',
} as const;

export const callbackEnvironment = {
  CALLBACK_TOKEN_KEY: Buffer.alloc(32, 71).toString('base64'),
  CALLBACK_TOKEN_KEY_VERSION: 'v1',
  PUBLIC_WEB_ORIGIN: 'https://app.example.test',
};
