import { canonicalEmail } from '@pertexo/workflow-model';
import { z } from 'zod';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  parseApplicationPreviousKeys,
  validateApplicationKeyRing,
} from '@pertexo/integrations/server';

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
  AUTH_MAIL_KEY_VERSION: z.string().optional(),
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
  try {
    if (args.length !== 2 || args[0] !== '--email') throw new TypeError();
    const email = z
      .email()
      .max(320)
      .parse(canonicalEmail(args[1] ?? ''));
    const values = environmentSchema.parse(environment);
    const deployed =
      values.NODE_ENV === 'production' || values.NODE_ENV === 'staging';
    const origin = new URL(values.PUBLIC_WEB_ORIGIN);
    assertRecoveryOrigin(origin, { deployed });
    const base = {
      email,
      actorRef: values.OPERATOR_ACTOR_REF,
      reason: values.OPERATOR_REASON,
      accountUrl: new URL('/account/security', origin).toString(),
      database: parseDatabaseConfig({
        connectionString: values.DATABASE_URL,
        ownerRole: values.POSTGRES_OWNER_USER,
        max: 1,
      }),
    };
    if (values.AUTH_MAIL_MODE === 'durable') {
      if (
        values.AUTH_MAIL_FROM === undefined ||
        values.AUTH_MAIL_KEY === undefined ||
        values.AUTH_MAIL_KEY_VERSION === undefined
      )
        throw new TypeError();
      return {
        ...base,
        mail: {
          mode: 'durable' as const,
          fromEmail: values.AUTH_MAIL_FROM,
          encryption: validateApplicationKeyRing({
            current: {
              key: values.AUTH_MAIL_KEY,
              version: values.AUTH_MAIL_KEY_VERSION,
            },
            previous: parseApplicationPreviousKeys(
              values.AUTH_MAIL_PREVIOUS_KEYS,
            ),
          }),
        },
      };
    }
    if (
      deployed ||
      [
        values.AUTH_MAIL_FROM,
        values.AUTH_MAIL_KEY,
        values.AUTH_MAIL_KEY_VERSION,
        values.AUTH_MAIL_PREVIOUS_KEYS,
      ].some((value) => value !== undefined)
    )
      throw new TypeError();
    return { ...base, mail: { mode: 'local' as const } };
  } catch {
    throw new TypeError(
      'Two-factor recovery configuration is invalid. Use --email and provide DATABASE_URL, operator identity and AUTH_MAIL settings.',
    );
  }
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
    (deployed && origin.protocol !== 'https:') ||
    !['https:', 'http:'].includes(origin.protocol);
  if (invalidApiOrigin) throw new TypeError();
}
