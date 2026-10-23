import { utf8ByteLength } from '@pertexo/workflow-model';
import { redactText } from '../../security/redact-text.js';

import { boundedRedactedBody } from '../stream-redaction.js';
import { SECURE_HTTP_ERROR_CODE, failure } from '../secure-error.js';

import type { ParsedSecureHttpRequest } from '../secure-request.js';

import {
  type SecureHttpResponse,
  type SecureHttpBodyConsumer,
  type SecureHttpTransportResponse,
  type RedirectState,
  POST_DISPATCH_AMBIGUITY,
} from './contract.js';
import { MAX_URL_BYTES } from './routing.js';
import { raceWithSignal } from './cancellation.js';

const safeResponseHeaders = new Set([
  'content-language',
  'content-type',
  'etag',
  'last-modified',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]);

export async function consumeFinalResponse<Body>(
  response: SecureHttpTransportResponse,
  state: RedirectState,
  request: ParsedSecureHttpRequest,
  executionSignal: AbortSignal,
  deadline: number,
  consume: SecureHttpBodyConsumer<Body>,
): Promise<SecureHttpResponse<Body>> {
  try {
    const selectedHeaders = selectResponseHeaders(
      response.headers,
      request.sensitiveValues,
    );
    const contentEncoding = response.headers['content-encoding'];
    if (
      contentEncoding !== undefined &&
      normalizedHeaderValue(contentEncoding).toLowerCase() !== 'identity'
    )
      throw failure(
        SECURE_HTTP_ERROR_CODE.responseEncodingRejected,
        true,
        false,
      );
    const textual = isTextualContentType(selectedHeaders['content-type'] ?? '');
    const bodyEncoding = textual ? ('utf8' as const) : ('base64' as const);
    const finalUrl = safeFinalUrl(state.url);
    const body = await raceWithSignal(
      consume(
        Object.freeze({
          status: response.status,
          headers: selectedHeaders,
          ...(request.navigation === undefined
            ? {}
            : {
                navigation: pageNavigation(
                  response,
                  state.url,
                  request.navigation.link,
                ),
              }),
          body: boundedRedactedBody(
            response.body,
            request.maxResponseBytes,
            executionSignal,
            request.sensitiveValues,
            deadline,
          ),
          cancelSource: () => {
            response.close();
          },
          bodyEncoding,
          finalUrl,
          redirectCount: state.redirectCount,
          signal: executionSignal,
        }),
      ),
      executionSignal,
      POST_DISPATCH_AMBIGUITY,
    );
    return Object.freeze({
      status: response.status,
      headers: selectedHeaders,
      body,
      bodyEncoding,
      finalUrl,
      redirectCount: state.redirectCount,
    });
  } finally {
    response.close();
  }
}

export async function collectBody(
  body: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    chunks.push(new Uint8Array(chunk));
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function selectResponseHeaders(
  headers: SecureHttpTransportResponse['headers'],
  sensitiveValues: readonly string[],
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!safeResponseHeaders.has(name) || rawValue === undefined) continue;
    const value = typeof rawValue === 'string' ? rawValue : rawValue.join(', ');
    selected[name] = redactText(value, sensitiveValues).slice(0, 2_048);
  }
  return Object.freeze(selected);
}

function isTextualContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript') ||
    normalized.includes('x-www-form-urlencoded')
  );
}

function safeFinalUrl(url: URL): string {
  return url.origin.slice(0, MAX_URL_BYTES);
}

function normalizedHeaderValue(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : value.join(', ');
}

function pageNavigation(
  response: SecureHttpTransportResponse,
  url: URL,
  includeLink: boolean,
): Readonly<{ url: string; link?: string }> {
  const raw = includeLink ? response.headers.link : undefined;
  const link = raw === undefined ? undefined : normalizedHeaderValue(raw);
  if (link !== undefined && utf8ByteLength(link) > 8192)
    throw failure(
      SECURE_HTTP_ERROR_CODE.paginationNavigationInvalid,
      true,
      false,
    );
  return { url: url.toString(), ...(link === undefined ? {} : { link }) };
}
