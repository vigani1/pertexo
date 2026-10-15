import { z } from 'zod';

import {
  applicationKeyVersionSchema,
  parseSystemMailConfig,
  type SystemMailConfig,
  parseApplicationPreviousKeys,
  type ApplicationKeyRing,
} from '@pertexo/integrations/server';

export type SystemMailDeliveryConfig = Readonly<{
  delivery: SystemMailConfig;
  timeoutMillis: number;
  pollIntervalMillis: number;
  workerId: string;
  encryption: ApplicationKeyRing;
}>;

const credentialNames = [
  'SYSTEM_MAIL_TRANSPORT',
  'AUTH_MAIL_EMAIL_API_KEY',
  'AUTH_MAIL_KEY',
  'AUTH_MAIL_KEY_VERSION',
] as const;

const authenticationMailSchema = z
  .object({
    key: z.string().min(1),
    version: applicationKeyVersionSchema,
    previous: z.string().optional(),
    timeoutMillis: z.coerce.number().int().min(100).max(30_000).default(5_000),
    pollIntervalMillis: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
    workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  })
  .strict();

/**
 * Parses authentication-mail delivery when any of its credentials is present;
 * without them a local worker does not deliver it. Deployed workers must.
 */
export function parseSystemMailDeliveryConfig(
  environment: Readonly<Record<string, string | undefined>>,
  deployed: boolean,
): SystemMailDeliveryConfig | undefined {
  if (credentialNames.every((name) => environment[name] === undefined)) {
    if (deployed)
      throw new Error('Deployed workers require authentication mail delivery');
    return undefined;
  }
  const parsed = authenticationMailSchema.parse({
    key: environment.AUTH_MAIL_KEY,
    version: environment.AUTH_MAIL_KEY_VERSION,
    previous: environment.AUTH_MAIL_PREVIOUS_KEYS,
    timeoutMillis: environment.AUTH_MAIL_EMAIL_TIMEOUT_MILLIS,
    pollIntervalMillis: environment.AUTH_MAIL_POLL_MILLIS,
    workerId: `auth-mail:${environment.WORKER_INSTANCE_ID ?? 'worker-local'}`,
  });
  return Object.freeze({
    delivery: parseSystemMailConfig(
      environment,
      'AUTH_MAIL_EMAIL_API_KEY',
      deployed,
    ),
    timeoutMillis: parsed.timeoutMillis,
    pollIntervalMillis: parsed.pollIntervalMillis,
    workerId: parsed.workerId,
    encryption: Object.freeze({
      current: Object.freeze({ version: parsed.version, key: parsed.key }),
      previous: parseApplicationPreviousKeys(parsed.previous),
    }),
  });
}
