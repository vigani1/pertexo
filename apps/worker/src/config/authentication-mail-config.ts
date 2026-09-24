import { z } from 'zod';

import {
  applicationKeyVersionSchema,
  parseApplicationPreviousKeys,
  type ApplicationKeyRing,
} from './application-key-ring.js';

export type AuthenticationMailDeliveryConfig = Readonly<{
  apiKey: string;
  timeoutMillis: number;
  pollIntervalMillis: number;
  workerId: string;
  encryption: ApplicationKeyRing;
}>;

const credentialNames = [
  'AUTH_MAIL_EMAIL_API_KEY',
  'AUTH_MAIL_KEY',
  'AUTH_MAIL_KEY_VERSION',
] as const;

const authenticationMailSchema = z
  .object({
    apiKey: z.string().min(1).max(512),
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
 * Parses the dedicated authentication-mail delivery configuration from the
 * already validated worker environment. Deployed workers must deliver
 * authentication mail, and a worker with delivery disabled fails closed when
 * it still carries delivery credentials instead of silently ignoring them.
 */
export function parseAuthenticationMailDeliveryConfig(
  environment: Readonly<Record<string, string | undefined>>,
  deployed: boolean,
): AuthenticationMailDeliveryConfig | undefined {
  const enabled = environment.AUTH_MAIL_DELIVERY_ENABLED === 'true';
  if (deployed && !enabled)
    throw new Error('Deployed workers require authentication mail delivery');
  if (!enabled) {
    if (credentialNames.every((name) => environment[name] === undefined))
      return undefined;
    throw new Error('Authentication mail delivery configuration is inactive');
  }
  const parsed = authenticationMailSchema.parse({
    apiKey: environment.AUTH_MAIL_EMAIL_API_KEY,
    key: environment.AUTH_MAIL_KEY,
    version: environment.AUTH_MAIL_KEY_VERSION,
    previous: environment.AUTH_MAIL_PREVIOUS_KEYS,
    timeoutMillis: environment.AUTH_MAIL_EMAIL_TIMEOUT_MILLIS,
    pollIntervalMillis: environment.AUTH_MAIL_POLL_MILLIS,
    workerId: `auth-mail:${environment.WORKER_INSTANCE_ID ?? 'worker-local'}`,
  });
  return Object.freeze({
    apiKey: parsed.apiKey,
    timeoutMillis: parsed.timeoutMillis,
    pollIntervalMillis: parsed.pollIntervalMillis,
    workerId: parsed.workerId,
    encryption: Object.freeze({
      current: Object.freeze({ version: parsed.version, key: parsed.key }),
      previous: parseApplicationPreviousKeys(parsed.previous),
    }),
  });
}
