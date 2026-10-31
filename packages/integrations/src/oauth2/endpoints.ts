import { isIP } from 'node:net';

import type { OAuth2ClientSettings } from '@pertexo/contracts';

import {
  isAllowedPrivateAddress,
  normalizeUrlHostname,
  type AllowedPrivateNetwork,
} from '../http/transport/address-policy.js';

const LOCAL_NAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
] as const;

export type OAuth2EndpointPolicy = Readonly<{
  allowedPrivateNetworks: readonly AllowedPrivateNetwork[];
  publicWebOrigin: string;
}>;

function comparableHost(hostname: string): string {
  return normalizeUrlHostname(hostname).toLowerCase().replace(/\.$/u, '');
}

function isLocalName(host: string): boolean {
  return (
    host === 'localhost' ||
    !host.includes('.') ||
    LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

function isRefused(address: string, policy: OAuth2EndpointPolicy): boolean {
  const url = new URL(address);
  const host = comparableHost(url.hostname);
  // Not even a private network makes Pertexo's own address a place to send a secret.
  if (host === comparableHost(new URL(policy.publicWebOrigin).hostname))
    return true;
  const literal = isIP(host) !== 0;
  if (policy.allowedPrivateNetworks.length > 0)
    // Names are settled at dispatch, where they resolve; an IP literal is settled here.
    return (
      literal && !isAllowedPrivateAddress(host, policy.allowedPrivateNetworks)
    );
  return url.protocol !== 'https:' || literal || isLocalName(host);
}

/** The one rule for which addresses a connection may store; the first refused field. */
export function refusedEndpoint(
  settings: OAuth2ClientSettings,
  policy: OAuth2EndpointPolicy,
): 'authorizationUrl' | 'tokenUrl' | undefined {
  if (
    settings.grantType === 'authorization_code' &&
    isRefused(settings.authorizationUrl, policy)
  )
    return 'authorizationUrl';
  return isRefused(settings.tokenUrl, policy) ? 'tokenUrl' : undefined;
}
