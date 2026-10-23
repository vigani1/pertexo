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
  noticeSender?: Readonly<{ fromEmail: string; publicWebOrigin: string }>;
}>;

const credentialNames = [
  'SYSTEM_MAIL_TRANSPORT',
  'AUTH_MAIL_EMAIL_API_KEY',
  'AUTH_MAIL_KEY',
  'AUTH_MAIL_KEY_VERSION',
  'AUTH_MAIL_FROM',
] as const;

const systemMailSchema = z
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
 * Parses system-mail delivery when any of its credentials is present;
 * without them a local worker does not deliver it. Deployed workers must.
 */
export function parseSystemMailDeliveryConfig(
  environment: Readonly<Record<string, string | undefined>>,
  deployed: boolean,
): SystemMailDeliveryConfig | undefined {
  if (credentialNames.every((name) => environment[name] === undefined)) {
    if (deployed)
      throw new Error('Deployed workers require system mail delivery');
    return undefined;
  }
  const parsed = systemMailSchema.parse({
    key: environment.AUTH_MAIL_KEY,
    version: environment.AUTH_MAIL_KEY_VERSION,
    previous: environment.AUTH_MAIL_PREVIOUS_KEYS,
    timeoutMillis: environment.AUTH_MAIL_EMAIL_TIMEOUT_MILLIS,
    pollIntervalMillis: environment.AUTH_MAIL_POLL_MILLIS,
    workerId: `auth-mail:${environment.WORKER_INSTANCE_ID ?? 'worker-local'}`,
  });
  if (deployed && environment.AUTH_MAIL_FROM === undefined)
    throw new Error(
      'Deployed workers require AUTH_MAIL_FROM for system notifications',
    );
  const noticeSender =
    environment.AUTH_MAIL_FROM === undefined
      ? undefined
      : {
          fromEmail: z.email().max(320).parse(environment.AUTH_MAIL_FROM),
          publicWebOrigin: z.url().parse(environment.PUBLIC_WEB_ORIGIN),
        };
  if (noticeSender !== undefined) {
    const origin = new URL(noticeSender.publicWebOrigin);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      (deployed && origin.protocol !== 'https:') ||
      !['http:', 'https:'].includes(origin.protocol)
    )
      throw new Error('Notification mail requires a public web origin');
  }
  return Object.freeze({
    ...(noticeSender === undefined ? {} : { noticeSender }),
    delivery: parseSystemMailConfig(environment, {
      apiKeyName: 'AUTH_MAIL_EMAIL_API_KEY',
      deployed,
    }),
    timeoutMillis: parsed.timeoutMillis,
    pollIntervalMillis: parsed.pollIntervalMillis,
    workerId: parsed.workerId,
    encryption: Object.freeze({
      current: Object.freeze({ version: parsed.version, key: parsed.key }),
      previous: parseApplicationPreviousKeys(parsed.previous),
    }),
  });
}
