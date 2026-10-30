import { randomBytes } from 'node:crypto';

const option = process.argv[2] ?? '--encryption=self-managed';
if (
  process.argv.length > 3 ||
  !['--encryption=kms', '--encryption=self-managed'].includes(option)
)
  throw new Error(
    'usage: generate-secrets.mjs [--encryption=self-managed|--encryption=kms]',
  );
const mode = option.slice('--encryption='.length);
process.stderr.write(
  'Generate only for a fresh installation. Never overwrite installed keys. Save encryption keys and their versions separately in your password manager.\n',
);
const hex = () => randomBytes(32).toString('hex');
const values = {
  CONNECTION_ENCRYPTION_MODE: mode,
  BETTER_AUTH_SECRET: hex(),
  AUTH_FEDERATION_KEY: randomBytes(32).toString('base64'),
  AUTH_FEDERATION_KEY_VERSION: '1',
  AUTH_MAIL_KEY: randomBytes(32).toString('base64'),
  AUTH_MAIL_KEY_VERSION: '1',
  INVITATION_TOKEN_KEY: randomBytes(32).toString('base64'),
  INVITATION_TOKEN_KEY_VERSION: '1',
  CALLBACK_TOKEN_KEY: randomBytes(32).toString('base64'),
  CALLBACK_TOKEN_KEY_VERSION: '1',
  POSTGRES_SUPERUSER_PASSWORD: hex(),
  POSTGRES_MIGRATION_PASSWORD: hex(),
  POSTGRES_APP_PASSWORD: hex(),
  POSTGRES_MAINTENANCE_PASSWORD: hex(),
  REDIS_PASSWORD: hex(),
  STORAGE_ADMIN_ACCESS_KEY_ID: hex(),
  STORAGE_ADMIN_SECRET_ACCESS_KEY: hex(),
  ARTIFACT_STORE_ACCESS_KEY_ID: hex(),
  ARTIFACT_STORE_SECRET_ACCESS_KEY: hex(),
};
if (mode === 'self-managed') {
  values.CONNECTION_SELF_MANAGED_KEY = randomBytes(32).toString('base64');
  values.CONNECTION_SELF_MANAGED_KEY_VERSION = '1';
}
for (const [variable, role] of [
  ['DATABASE_MIGRATION_URL', 'MIGRATION'],
  ['DATABASE_URL', 'APP'],
  ['DATABASE_MAINTENANCE_URL', 'MAINTENANCE'],
]) {
  values[variable] =
    `postgresql://pertexo_${role.toLowerCase()}:${values[`POSTGRES_${role}_PASSWORD`]}@postgres:5432/pertexo`;
}
values.REDIS_URL = `redis://:${values.REDIS_PASSWORD}@redis:6379/0`;
process.stdout.write(
  Object.entries(values)
    .map(([key, value]) => `${key}='${value}'\n`)
    .join(''),
);
