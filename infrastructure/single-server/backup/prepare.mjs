import { writeFile } from 'node:fs/promises';
import { parseRecoveryStores } from './stores.mjs';
const { source, backup: destination } = parseRecoveryStores(process.env);
const directory = process.argv[2];
if (!directory) throw new Error('A private output directory is required');
const fields = (config) => ({
  TYPE: 's3',
  PROVIDER: 'Other',
  ENV_AUTH: 'false',
  FORCE_PATH_STYLE: 'true',
  NO_CHECK_BUCKET: 'true',
  ACCESS_KEY_ID: config.accessKeyId,
  SECRET_ACCESS_KEY: config.secretAccessKey,
  REGION: config.region,
  ENDPOINT: config.endpoint,
});
const values = {
  SOURCE: fields({ ...source, endpoint: 'http://storage:9000' }),
  BACKUP: fields(destination),
};
const lines = ['RCLONE_CONFIG=/dev/null'];
for (const [remote, settings] of Object.entries(values)) {
  for (const [field, value] of Object.entries(settings)) {
    if (/[\r\n]/u.test(value))
      throw new Error(`Backup ${field} must fit on one line`);
    lines.push(`RCLONE_CONFIG_${remote}_${field}=${value}`);
  }
}
await writeFile(`${directory}/rclone.env`, lines.join('\n') + '\n', {
  mode: 0o600,
});
await writeFile(`${directory}/source-bucket`, source.bucket, { mode: 0o600 });
await writeFile(`${directory}/backup-bucket`, destination.bucket, {
  mode: 0o600,
});
