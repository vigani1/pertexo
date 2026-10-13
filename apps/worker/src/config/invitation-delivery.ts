import { z } from 'zod';

import {
  applicationKeyVersionSchema,
  parseSystemMailConfig,
  type SystemMailConfig,
  parseApplicationPreviousKeys,
  type ApplicationKeyRing,
} from '@pertexo/integrations/server';

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
  deployed: boolean,
): InvitationDeliveryConfig | undefined {
  if (
    invitationDeliveryVariableNames.every(
      (name) => environment[name] === undefined,
    )
  )
    return undefined;
  const parsed = z
    .object({
      fromEmail: z.email().max(320),
      webOrigin: z.url(),
      timeoutMillis: z.coerce
        .number()
        .int()
        .min(100)
        .max(30_000)
        .default(5_000),
      key: z.string().min(1),
      version: applicationKeyVersionSchema,
      previous: z.string().optional(),
    })
    .strict()
    .parse({
      fromEmail: environment.INVITATION_EMAIL_FROM,
      webOrigin: environment.PUBLIC_WEB_ORIGIN,
      timeoutMillis: environment.INVITATION_EMAIL_TIMEOUT_MILLIS,
      key: environment.INVITATION_TOKEN_KEY,
      version: environment.INVITATION_TOKEN_KEY_VERSION,
      previous: environment.INVITATION_TOKEN_PREVIOUS_KEYS,
    });
  const url = new URL(parsed.webOrigin);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new Error('PUBLIC_WEB_ORIGIN must be an origin without a path');
  if (deployed && url.protocol !== 'https:')
    throw new Error('HTTPS public web origin is required when deployed');
  const previous = parseApplicationPreviousKeys(parsed.previous);
  return Object.freeze({
    delivery: parseSystemMailConfig(
      environment,
      'INVITATION_EMAIL_API_KEY',
      deployed,
    ),
    fromEmail: parsed.fromEmail,
    webOrigin: url.origin,
    timeoutMillis: parsed.timeoutMillis,
    tokenEncryption: Object.freeze({
      current: Object.freeze({ version: parsed.version, key: parsed.key }),
      previous,
    }),
  });
}
