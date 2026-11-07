import {
  StartupSettingError,
  parseStartupSettings,
} from '@pertexo/observability/startup';
import { canonicalEmail } from '@pertexo/core/identity';
import { z } from 'zod';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  parseApplicationPreviousKeys,
  applicationKeyVersionSchema,
  ApplicationKeyConfigurationError,
  validateApplicationKeyRing,
} from '@pertexo/secrets/server';

const environmentSchema = z.object({
  DATABASE_URL: z.string(),
  POSTGRES_OWNER_USER: z.string().default('pertexo_owner'),
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),
  OPERATOR_ACTOR_REF: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u),
  OPERATOR_REASON: z.string().trim().min(1).max(512),
  PUBLIC_WEB_ORIGIN: z.url(),
  AUTH_MAIL_MODE: z.enum(['local', 'durable']).default('local'),
  AUTH_MAIL_FROM: z.email().max(320).optional(),
  AUTH_MAIL_KEY: z.string().optional(),
  AUTH_MAIL_KEY_VERSION: applicationKeyVersionSchema.optional(),
  AUTH_MAIL_PREVIOUS_KEYS: z.string().optional(),
});
export type TwoFactorRecoveryConfig = ReturnType<
  typeof parseTwoFactorRecoveryConfig
>;

/** One privileged command, with no password, authenticator secret or backup code as input. */
export function parseTwoFactorRecoveryConfig(
  args: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (args.length !== 2 || args[0] !== '--email')
    throw new StartupSettingError('EMAIL', 'recovery_arguments_required');
  const emailResult = z
    .email()
    .max(320)
    .safeParse(canonicalEmail(args[1] ?? ''));
  if (!emailResult.success)
    throw new StartupSettingError('EMAIL', 'recovery_arguments_required');
  const email = emailResult.data;
  const values = parseStartupSettings(environmentSchema, environment, {
    DATABASE_URL: 'database_url_required',
    POSTGRES_OWNER_USER: 'database_url_required',
    NODE_ENV: 'node_environment_required',
    OPERATOR_ACTOR_REF: 'operator_ref_required',
    OPERATOR_REASON: 'operator_reason_required',
    PUBLIC_WEB_ORIGIN: 'http_origin_required',
    AUTH_MAIL_MODE: 'durable_mail_required',
    AUTH_MAIL_FROM: 'email_required',
    AUTH_MAIL_KEY: 'application_key_required',
    AUTH_MAIL_KEY_VERSION: 'key_version_required',
    AUTH_MAIL_PREVIOUS_KEYS: 'previous_keys_required',
  });
  const deployed =
    values.NODE_ENV === 'production' || values.NODE_ENV === 'staging';
  const origin = new URL(values.PUBLIC_WEB_ORIGIN);
  assertRecoveryOrigin(origin, { deployed });
  let database;
  try {
    database = parseDatabaseConfig({
      connectionString: values.DATABASE_URL,
      ownerRole: values.POSTGRES_OWNER_USER,
      max: 1,
    });
  } catch {
    throw new StartupSettingError('DATABASE_URL', 'database_url_required');
  }
  const base = {
    email,
    actorRef: values.OPERATOR_ACTOR_REF,
    reason: values.OPERATOR_REASON,
    accountUrl: new URL('/account/security', origin).toString(),
    database,
  };
  if (values.AUTH_MAIL_MODE === 'durable') {
    if (values.AUTH_MAIL_FROM === undefined)
      throw new StartupSettingError('AUTH_MAIL_FROM', 'email_required');
    if (values.AUTH_MAIL_KEY_VERSION === undefined)
      throw new StartupSettingError(
        'AUTH_MAIL_KEY_VERSION',
        'key_version_required',
      );
    if (values.AUTH_MAIL_KEY === undefined)
      throw new StartupSettingError(
        'AUTH_MAIL_KEY',
        'application_key_required',
      );
    let encryption;
    try {
      encryption = validateApplicationKeyRing({
        current: {
          key: values.AUTH_MAIL_KEY,
          version: values.AUTH_MAIL_KEY_VERSION,
        },
        previous: parseApplicationPreviousKeys(values.AUTH_MAIL_PREVIOUS_KEYS),
      });
    } catch (error: unknown) {
      if (
        error instanceof ApplicationKeyConfigurationError &&
        error.section === 'current'
      )
        throw new StartupSettingError(
          'AUTH_MAIL_KEY',
          'application_key_required',
        );
      throw new StartupSettingError(
        'AUTH_MAIL_PREVIOUS_KEYS',
        'previous_keys_required',
      );
    }
    return {
      ...base,
      mail: {
        mode: 'durable' as const,
        fromEmail: values.AUTH_MAIL_FROM,
        encryption,
      },
    };
  }
  if (deployed)
    throw new StartupSettingError('AUTH_MAIL_MODE', 'durable_mail_required');
  if (
    [
      values.AUTH_MAIL_FROM,
      values.AUTH_MAIL_KEY,
      values.AUTH_MAIL_KEY_VERSION,
      values.AUTH_MAIL_PREVIOUS_KEYS,
    ].some((value) => value !== undefined)
  )
    throw new StartupSettingError('AUTH_MAIL_MODE', 'local_mail_required');
  return { ...base, mail: { mode: 'local' as const } };
}

function assertRecoveryOrigin(
  origin: URL,
  { deployed }: Readonly<{ deployed: boolean }>,
): void {
  const invalidApiOrigin =
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    origin.username !== '' ||
    origin.password !== '' ||
    !['https:', 'http:'].includes(origin.protocol);
  if (invalidApiOrigin)
    throw new StartupSettingError('PUBLIC_WEB_ORIGIN', 'http_origin_required');
  if (deployed && origin.protocol !== 'https:')
    throw new StartupSettingError('PUBLIC_WEB_ORIGIN', 'https_required');
}
