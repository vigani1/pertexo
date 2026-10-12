import { parseArtifactStoreConfig } from '../../../packages/artifact-store/dist/config/index.js';

export function parseRecoveryStores(environment) {
  const source = parseArtifactStoreConfig(environment);
  const backup = parseArtifactStoreConfig(
    Object.fromEntries(
      [
        'ENDPOINT',
        'REGION',
        'BUCKET',
        'ACCESS_KEY_ID',
        'SECRET_ACCESS_KEY',
      ].map((name) => [
        `ARTIFACT_STORE_${name}`,
        environment[`BACKUP_STORE_${name}`],
      ]),
    ),
  );
  if (new URL(backup.endpoint).protocol !== 'https:')
    throw new Error('Off-server backups require HTTPS');
  if (new URL(backup.endpoint).origin === new URL(source.endpoint).origin)
    throw new Error('Backups require a different storage endpoint');
  return { source: { ...source, endpoint: 'http://storage:9000' }, backup };
}
