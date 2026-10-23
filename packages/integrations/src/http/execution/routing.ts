import { utf8ByteLength } from '@pertexo/workflow-model';

import type { NodeVerifiedByteSource } from '@pertexo/node-sdk/server';
import { isIP } from 'node:net';

import { SECURE_HTTP_ERROR_CODE, failure } from '../secure-error.js';

import type { ParsedSecureHttpRequest } from '../secure-request.js';

import type {
  SecureHttpRequest,
  SecureHttpTransportResponse,
  RedirectState,
} from './contract.js';

export const MAX_URL_BYTES = 2_048;

export function assertResponseStatus(
  response: SecureHttpTransportResponse,
): void {
  if (
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599
  ) {
    response.close();
    throw failure(SECURE_HTTP_ERROR_CODE.networkFailed, {
      possiblyDispatched: true,
      ambiguous: true,
    });
  }
}

export function redirectTransition(
  response: SecureHttpTransportResponse,
  current: RedirectState,
  request: ParsedSecureHttpRequest,
  location: string,
): RedirectState {
  if (current.redirectCount >= request.maxRedirects)
    throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, {
      possiblyDispatched: true,
      ambiguous: false,
    });
  const nextUrl = parseRedirectUrl(location, current.url);
  if (
    request.navigation !== undefined &&
    nextUrl.origin !== request.navigation.origin
  )
    throw failure(SECURE_HTTP_ERROR_CODE.paginationOriginChanged, {
      possiblyDispatched: true,
      ambiguous: false,
    });
  if (current.url.protocol === 'https:' && nextUrl.protocol !== 'https:')
    throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, {
      possiblyDispatched: true,
      ambiguous: false,
    });
  if (
    request.sensitiveValues.length > 0 &&
    nextUrl.origin !== current.url.origin
  )
    throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, {
      possiblyDispatched: true,
      ambiguous: false,
    });
  const nextRequest = redirectRequest(
    response.status,
    current.method,
    current.body,
    current.headers,
  );
  return Object.freeze({
    ...nextRequest,
    url: nextUrl,
    redirectCount: current.redirectCount + 1,
  });
}

export function parseTargetUrl(value: string): URL {
  try {
    if (utf8ByteLength(value) > MAX_URL_BYTES) throw new Error('URL too long');
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('unsupported scheme');
    if (url.username !== '' || url.password !== '' || url.hash !== '')
      throw new Error('URL credentials and fragments are not allowed');
    return url;
  } catch (error: unknown) {
    throw failure(SECURE_HTTP_ERROR_CODE.invalidRequest, {
      possiblyDispatched: false,
      ambiguous: false,
      cause: error,
    });
  }
}

function parseRedirectUrl(location: string, current: URL): URL {
  try {
    return parseTargetUrl(new URL(location, current).toString());
  } catch (error: unknown) {
    throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, {
      possiblyDispatched: true,
      ambiguous: false,
      cause: error,
    });
  }
}

export function literalAddressFamily(hostname: string): 4 | 6 | undefined {
  // URL parsing canonicalizes alternate IPv4 spellings before this boundary.
  // DNS labels may contain only hexadecimal letters without being IP literals.
  const family = isIP(hostname);
  if (family === 0) return undefined;
  return family === 4 ? 4 : 6;
}

export function redirectLocation(
  response: SecureHttpTransportResponse,
): string | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
  const location = response.headers.location;
  return typeof location === 'string' ? location : location?.[0];
}

function redirectRequest(
  status: number,
  method: SecureHttpRequest['method'],
  body: Uint8Array | NodeVerifiedByteSource | undefined,
  headers: Readonly<Record<string, string>>,
): Readonly<{
  method: SecureHttpRequest['method'];
  body?: Uint8Array | NodeVerifiedByteSource;
  headers: Readonly<Record<string, string>>;
}> {
  if (status === 307 || status === 308)
    return {
      method,
      ...(body === undefined ? {} : { body }),
      headers,
    };
  if (method !== 'GET' && method !== 'HEAD')
    throw failure(SECURE_HTTP_ERROR_CODE.redirectRejected, {
      possiblyDispatched: true,
      ambiguous: false,
    });
  return { method, headers };
}
