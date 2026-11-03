import { isIP } from 'node:net';

import type { OAuth2ClientSettings } from '@pertexo/contracts';

const LOCAL_NAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
] as const;

export type OAuth2EndpointPolicy = Readonly<{
  privateNetworksAllowed: boolean;
  isAllowedPrivateAddress(address: string): boolean;
  normalizeHostname(hostname: string): string;
  publicWebOrigin: string;
}>;

function comparableHost(
  hostname: string,
  policy: OAuth2EndpointPolicy,
): string {
  return policy.normalizeHostname(hostname).toLowerCase().replace(/\.$/u, '');
}

function isLocalName(host: string): boolean {
  return (
    host === 'localhost' ||
    !host.includes('.') ||
    LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

function isRefused(
  address: string,
  field: 'authorizationUrl' | 'tokenUrl',
  policy: OAuth2EndpointPolicy,
): boolean {
  const url = new URL(address);
  const host = comparableHost(url.hostname, policy);
  // Not even a private network makes Pertexo's own address a place to send a secret.
  if (host === comparableHost(new URL(policy.publicWebOrigin).hostname, policy))
    return true;
  const literal = isIP(host) !== 0;
  if (policy.privateNetworksAllowed) {
    // An IP literal is settled here. Names are settled at dispatch, where they
    // resolve, but the browser alone opens the authorization URL: no dispatch ever
    // refuses it, so consent can't start in cleartext at what looks like a public name.
    if (literal) return !policy.isAllowedPrivateAddress(host);
    return (
      field === 'authorizationUrl' &&
      url.protocol !== 'https:' &&
      !isLocalName(host)
    );
  }
  return url.protocol !== 'https:' || literal || isLocalName(host);
}

/** The one rule for which addresses a connection may store; the first refused field. */
export function refusedEndpoint(
  settings: OAuth2ClientSettings,
  policy: OAuth2EndpointPolicy,
): 'authorizationUrl' | 'tokenUrl' | undefined {
  if (
    settings.grantType === 'authorization_code' &&
    isRefused(settings.authorizationUrl, 'authorizationUrl', policy)
  )
    return 'authorizationUrl';
  return isRefused(settings.tokenUrl, 'tokenUrl', policy)
    ? 'tokenUrl'
    : undefined;
}
