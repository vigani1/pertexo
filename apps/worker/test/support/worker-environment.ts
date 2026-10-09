/** The least a worker needs to start: its databases, Redis and artifact storage. */
export const workerEnvironment = Object.freeze({
  DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
  DATABASE_MAINTENANCE_URL:
    'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
  REDIS_URL: 'redis://localhost:6379/0',
  ARTIFACT_STORE_ACCESS_KEY_ID: 'local-access',
  ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
  ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
  ARTIFACT_STORE_REGION: 'us-east-1',
  ARTIFACT_STORE_SECRET_ACCESS_KEY: 'local-secret',
});
