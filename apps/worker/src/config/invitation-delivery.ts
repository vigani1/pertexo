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

export type InvitationDeliveryConfig = Readonly<{
  delivery: SystemMailConfig;
  fromEmail: string;
  webOrigin: string;
  timeoutMillis: number;
  tokenEncryption: ApplicationKeyRing;
}>;

// PUBLIC_WEB_ORIGIN is shared with the API's sign-in, so it alone does not
// mean invitation delivery is configured; delivery still requires it.
const invitationDeliveryVariableNames = [
  'SYSTEM_MAIL_TRANSPORT',
  'INVITATION_EMAIL_API_KEY',
  'INVITATION_EMAIL_FROM',
  'INVITATION_TOKEN_KEY',
  'INVITATION_TOKEN_KEY_VERSION',
] as const;

/**
 * Parses workspace-invitation delivery configuration when any of its own
 * variables is present; without them the worker does not deliver invitations.
 */
export function parseInvitationDeliveryConfig(
  environment: Readonly<Record<string, string | undefined>>,
  { deployed }: Readonly<{ deployed: boolean }>,
): InvitationDeliveryConfig | undefined {
  if (
    invitationDeliveryVariableNames.every(
      (name) => environment[name] === undefined,
    )
  )
    return undefined;
  const parsed = parseStartupSettings(
    z.object({
      INVITATION_EMAIL_FROM: z.email().max(320),
      PUBLIC_WEB_ORIGIN: z.url(),
      INVITATION_EMAIL_TIMEOUT_MILLIS: z.coerce
        .number()
        .int()
        .min(100)
        .max(30_000)
        .default(5_000),
      INVITATION_TOKEN_KEY: z.string().min(1),
      INVITATION_TOKEN_KEY_VERSION: applicationKeyVersionSchema,
      INVITATION_TOKEN_PREVIOUS_KEYS: z.string().optional(),
    }),
    environment,
    {
      INVITATION_EMAIL_FROM: 'email_required',
      PUBLIC_WEB_ORIGIN: 'http_origin_required',
      INVITATION_EMAIL_TIMEOUT_MILLIS: 'timeout_required',
      INVITATION_TOKEN_KEY: 'application_key_required',
      INVITATION_TOKEN_KEY_VERSION: 'key_version_required',
      INVITATION_TOKEN_PREVIOUS_KEYS: 'previous_keys_required',
    },
  );
  const url = new URL(parsed.PUBLIC_WEB_ORIGIN);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new StartupSettingError('PUBLIC_WEB_ORIGIN', 'http_origin_required');
  if (deployed && url.protocol !== 'https:')
    throw new StartupSettingError('PUBLIC_WEB_ORIGIN', 'https_required');
  return Object.freeze({
    delivery: parseMailTransport(environment, {
      apiKeyName: 'INVITATION_EMAIL_API_KEY',
      deployed,
    }),
    fromEmail: parsed.INVITATION_EMAIL_FROM,
    webOrigin: url.origin,
    timeoutMillis: parsed.INVITATION_EMAIL_TIMEOUT_MILLIS,
    tokenEncryption: Object.freeze({
      current: Object.freeze({
        version: parsed.INVITATION_TOKEN_KEY_VERSION,
        key: parsed.INVITATION_TOKEN_KEY,
      }),
      previous: readMailPreviousKeys(
        'INVITATION_TOKEN_PREVIOUS_KEYS',
        parsed.INVITATION_TOKEN_PREVIOUS_KEYS,
      ),
    }),
  });
}
