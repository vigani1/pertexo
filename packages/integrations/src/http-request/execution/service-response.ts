import {
  MAXIMUM_RESPONSE_EXCERPT_CHARACTERS,
  type ServiceResponseFacts,
} from '@pertexo/node-sdk/server';

import { redactText } from '../../security/redact-text.js';
import type { HttpRequestConfig } from '../validation.js';

type ResponseBody =
  | Readonly<{ kind: 'inline'; encoding: 'utf8' | 'base64'; value: string }>
  | Readonly<{ kind: 'artifact' }>;

/** The address without its query or credentials, which is all a failure may show. */
function shownUrl(url: string, sensitiveValues: readonly string[]): string {
  const { origin, pathname } = new URL(url);
  return redactText(`${origin}${pathname}`, sensitiveValues);
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
  config: Pick<HttpRequestConfig, 'method' | 'url'>,
  answer: Readonly<{ status: number; body?: ResponseBody }>,
  sensitiveValues: readonly string[],
): ServiceResponseFacts {
  return {
    method: config.method,
    url: shownUrl(config.url, sensitiveValues),
    status: answer.status,
    body: answer.body === undefined ? { kind: 'none' } : shownBody(answer.body),
  };
}
