import { rclone } from './transport.mjs';
import { writeRcloneConfig } from './rclone-config.mjs';
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
const password = process.env.BACKUP_CRYPT_PASSWORD;
const salt = process.env.BACKUP_CRYPT_SALT;
if (password || salt) {
  for (const name of ['BACKUP_CRYPT_PASSWORD', 'BACKUP_CRYPT_SALT']) {
    if (!process.env[name] || /[\r\n]/u.test(process.env[name]))
      throw new Error(`Provide ${name} from the separately held settings file`);
  }
  const obscure = async (value) =>
    (await rclone(['obscure', '-'], { input: value })).trim();
  values.CRYPT = {
    TYPE: 'crypt',
    REMOTE: `backup:${destination.bucket}/encrypted`,
    FILENAME_ENCRYPTION: 'standard',
    DIRECTORY_NAME_ENCRYPTION: 'true',
    PASSWORD: await obscure(password),
    PASSWORD2: await obscure(salt),
  };
}
await writeRcloneConfig(`${directory}/rclone.conf`, values);
await writeFile(`${directory}/source-bucket`, source.bucket, { mode: 0o600 });
await writeFile(`${directory}/backup-bucket`, destination.bucket, {
  mode: 0o600,
});
