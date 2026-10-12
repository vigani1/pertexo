import { randomBytes } from 'node:crypto';

const hex = () => randomBytes(32).toString('hex');
const values = {
  BETTER_AUTH_SECRET: hex(),
  AUTH_MAIL_KEY: randomBytes(32).toString('base64'),
  AUTH_MAIL_KEY_VERSION: '1',
  INVITATION_TOKEN_KEY: randomBytes(32).toString('base64'),
  INVITATION_TOKEN_KEY_VERSION: '1',
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
