import {
  StartupSettingError,
  parseStartupSettings,
} from '@pertexo/observability/startup';
import { readMailPreviousKeys, parseMailTransport } from './mail-settings.js';
import { z } from 'zod';

import {
  applicationKeyVersionSchema,
  type ApplicationKeyRing,
} from '@pertexo/secrets/server';
import type { SystemMailConfig } from '@pertexo/secrets/server';

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

const systemMailSchema = z.object({
  AUTH_MAIL_KEY: z.string().min(1),
  AUTH_MAIL_KEY_VERSION: applicationKeyVersionSchema,
  AUTH_MAIL_PREVIOUS_KEYS: z.string().optional(),
  AUTH_MAIL_EMAIL_TIMEOUT_MILLIS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(5_000),
  AUTH_MAIL_POLL_MILLIS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(1_000),
  WORKER_INSTANCE_ID: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
});

/**
 * Parses system-mail delivery when any of its credentials is present;
 * without them a local worker does not deliver it. Deployed workers must.
 */
export function parseSystemMailDeliveryConfig(
  environment: Readonly<Record<string, string | undefined>>,
  { deployed }: Readonly<{ deployed: boolean }>,
): SystemMailDeliveryConfig | undefined {
  if (credentialNames.every((name) => environment[name] === undefined)) {
    if (deployed)
      throw new StartupSettingError('AUTH_MAIL_KEY', 'required_when_deployed');
    return undefined;
  }
  const parsed = parseStartupSettings(
    systemMailSchema,
    {
      ...environment,
      WORKER_INSTANCE_ID: `auth-mail:${environment.WORKER_INSTANCE_ID ?? 'worker-local'}`,
    },
    {
      AUTH_MAIL_KEY: 'application_key_required',
      AUTH_MAIL_KEY_VERSION: 'key_version_required',
      AUTH_MAIL_PREVIOUS_KEYS: 'previous_keys_required',
      AUTH_MAIL_EMAIL_TIMEOUT_MILLIS: 'timeout_required',
      AUTH_MAIL_POLL_MILLIS: 'poll_interval_required',
      WORKER_INSTANCE_ID: 'worker_id_required',
    },
  );
  if (deployed && environment.AUTH_MAIL_FROM === undefined)
    throw new StartupSettingError('AUTH_MAIL_FROM', 'required_when_deployed');
  const noticeSender =
    environment.AUTH_MAIL_FROM === undefined
      ? undefined
      : {
          fromEmail: parseStartupSettings(
            z.object({ AUTH_MAIL_FROM: z.email().max(320) }),
            environment,
            { AUTH_MAIL_FROM: 'email_required' },
          ).AUTH_MAIL_FROM,
          publicWebOrigin: parseStartupSettings(
            z.object({ PUBLIC_WEB_ORIGIN: z.url() }),
            environment,
            { PUBLIC_WEB_ORIGIN: 'http_origin_required' },
          ).PUBLIC_WEB_ORIGIN,
        };
  if (noticeSender !== undefined) {
    const origin = new URL(noticeSender.publicWebOrigin);
    const invalidMailOrigin =
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      (deployed && origin.protocol !== 'https:') ||
      !['http:', 'https:'].includes(origin.protocol);
    if (invalidMailOrigin)
      throw new StartupSettingError(
        'PUBLIC_WEB_ORIGIN',
        'http_origin_required',
      );
  }
  return Object.freeze({
    ...(noticeSender === undefined ? {} : { noticeSender }),
    delivery: parseMailTransport(environment, {
      apiKeyName: 'AUTH_MAIL_EMAIL_API_KEY',
      deployed,
    }),
    timeoutMillis: parsed.AUTH_MAIL_EMAIL_TIMEOUT_MILLIS,
    pollIntervalMillis: parsed.AUTH_MAIL_POLL_MILLIS,
    workerId: parsed.WORKER_INSTANCE_ID,
    encryption: Object.freeze({
      current: Object.freeze({
        version: parsed.AUTH_MAIL_KEY_VERSION,
        key: parsed.AUTH_MAIL_KEY,
      }),
      previous: readMailPreviousKeys(
        'AUTH_MAIL_PREVIOUS_KEYS',
        parsed.AUTH_MAIL_PREVIOUS_KEYS,
      ),
    }),
  });
}
