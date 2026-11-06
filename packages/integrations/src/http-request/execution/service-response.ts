import {
  MAXIMUM_RESPONSE_EXCERPT_CHARACTERS,
  MAXIMUM_SERVICE_RESPONSE_URL_CHARACTERS,
  type ServiceResponseFacts,
} from '@pertexo/node-sdk/server';

import type { ProviderHttpClient } from '../../providers/http-client.js';
type TextRedactor = ProviderHttpClient['redactText'];
import type { HttpRequestConfig } from '../http-request.schemas.js';

type ResponseBody =
  | Readonly<{ kind: 'inline'; encoding: 'utf8' | 'base64'; value: string }>
  | Readonly<{ kind: 'artifact' }>;

/** The address without its query or credentials, which is all a failure may show. */
function shownUrl(
  redactText: TextRedactor,
  url: string,
  sensitiveValues: readonly string[],
): string {
  const { origin, pathname } = new URL(url);
  const redacted = redactText(`${origin}${pathname}`, sensitiveValues);
  if (redacted.length <= MAXIMUM_SERVICE_RESPONSE_URL_CHARACTERS)
    return redacted;
  // Redact before shortening, and never leave a partial percent escape in the path.
  return `${redacted.slice(0, MAXIMUM_SERVICE_RESPONSE_URL_CHARACTERS - 1).replace(/%[0-9a-f]?$/iu, '')}…`;
}

function shownBody(body: ResponseBody): ServiceResponseFacts['body'] {
  if (body.kind !== 'inline') return { kind: 'too_large' };
  if (body.encoding !== 'utf8') return { kind: 'binary' };
  if (body.value === '') return { kind: 'none' };
  return {
    kind: 'text',
    excerpt:
      body.value.length > MAXIMUM_RESPONSE_EXCERPT_CHARACTERS
        ? `${body.value.slice(0, MAXIMUM_RESPONSE_EXCERPT_CHARACTERS)}…`
        : body.value,
  };
}

/** What a failed step shows. The secure client already redacted the body in transit. */
export function serviceResponseFacts(
  redactText: TextRedactor,
  config: Pick<HttpRequestConfig, 'method' | 'url'>,
  answer: Readonly<{ status: number; body?: ResponseBody }>,
  sensitiveValues: readonly string[],
): ServiceResponseFacts {
  return {
    method: config.method,
    url: shownUrl(redactText, config.url, sensitiveValues),
    status: answer.status,
    body: answer.body === undefined ? { kind: 'none' } : shownBody(answer.body),
  };
}
