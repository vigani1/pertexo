import { createHash, randomBytes } from 'node:crypto';

import {
  oauth2CallbackStateSchema,
  type OAuth2ClientSettings,
} from '@pertexo/contracts';

const WORKSPACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 256 random bits, shown once; only its digest is stored. */
export function newOAuth2Secret(): string {
  return randomBytes(32).toString('base64url');
}

export function oauth2Digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** The workspace comes first because it selects row security on the way back. */
export function newOAuth2State(workspaceId: string): string {
  const workspace = Buffer.from(
    workspaceId.replaceAll('-', ''),
    'hex',
  ).toString('base64url');
  return `${workspace}.${newOAuth2Secret()}`;
}

export function oauth2StateWorkspace(state: unknown): string | undefined {
  const parsed = oauth2CallbackStateSchema.safeParse(state);
  if (!parsed.success) return undefined;
  const hex = Buffer.from(
    parsed.data.slice(0, parsed.data.indexOf('.')),
    'base64url',
  ).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return WORKSPACE_ID.test(id) ? id : undefined;
}

/** What a verifier derives from: `deriveJourneySecret` keeps it out of storage. */
export function oauth2VerifierPurpose(state: string): string {
  return `oauth2-pkce:${state}`;
}

function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function oauth2AuthorizationAddress(
  settings: Extract<OAuth2ClientSettings, { grantType: 'authorization_code' }>,
  input: Readonly<{ redirectUri: string; state: string; verifier: string }>,
): string {
  const url = new URL(settings.authorizationUrl);
  const parameters = url.searchParams;
  parameters.set('response_type', 'code');
  parameters.set('client_id', settings.clientId);
  parameters.set('redirect_uri', input.redirectUri);
  parameters.set('state', input.state);
  if (settings.scope !== '') parameters.set('scope', settings.scope);
  if (settings.pkce === 's256') {
    parameters.set('code_challenge', s256Challenge(input.verifier));
    parameters.set('code_challenge_method', 'S256');
  }
  for (const [name, value] of Object.entries(settings.authorizationParameters))
    parameters.set(name, value);
  return url.toString();
}
