import { z } from 'zod';

import {
  applicationKeyVersionSchema,
  parseApplicationPreviousKeys,
  type ApplicationKeyRing,
} from './application-key-ring.js';

export type InvitationDeliveryConfig = Readonly<{
  apiKey: string;
  fromEmail: string;
  webOrigin: string;
  timeoutMillis: number;
  tokenEncryption: ApplicationKeyRing;
}>;

const invitationDeliveryVariableNames = [
  'INVITATION_EMAIL_API_KEY',
  'INVITATION_EMAIL_FROM',
  'INVITATION_TOKEN_KEY',
  'INVITATION_TOKEN_KEY_VERSION',
  'PUBLIC_WEB_ORIGIN',
] as const;

/**
 * Parses workspace-invitation delivery configuration. It is required when the
 * worker dispatches invitation delivery and otherwise parsed only when present.
 */
export function parseInvitationDeliveryConfig(
  environment: Readonly<Record<string, string | undefined>>,
  enabled: boolean,
  deployed: boolean,
): InvitationDeliveryConfig | undefined {
  if (
    !enabled &&
    invitationDeliveryVariableNames.every(
      (name) => environment[name] === undefined,
    )
  )
    return undefined;
  const parsed = z
    .object({
      apiKey: z.string().min(1).max(512),
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
      apiKey: environment.INVITATION_EMAIL_API_KEY,
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
    apiKey: parsed.apiKey,
    fromEmail: parsed.fromEmail,
    webOrigin: url.origin,
    timeoutMillis: parsed.timeoutMillis,
    tokenEncryption: Object.freeze({
      current: Object.freeze({ version: parsed.version, key: parsed.key }),
      previous,
    }),
  });
}
