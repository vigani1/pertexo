import { webhookContentTypeSchema } from '@pertexo/contracts';

import { searchFields } from './details.js';

const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9.-]+\+)?json$/u;

/**
 * The lowercase media type of a POST body, '' for an empty body sent without
 * one, or undefined when the body can't be read.
 */
export function webhookMediaType(
  contentType: string | undefined,
  bodyBytes: number,
): string | undefined {
  if (contentType === undefined) return bodyBytes === 0 ? '' : undefined;
  if (!webhookContentTypeSchema.safeParse(contentType).success)
    return undefined;
  return contentType.split(';', 1)[0]?.trim().toLowerCase();
}

export type ParsedWebhookBody =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{
      ok: false;
      problem: 'webhook.invalid_json' | 'request.invalid';
    }>;

/** A form reads as fields, text as one string and an empty body as `{}`. */
export function parseWebhookBody(
  mediaType: string,
  body: Uint8Array,
): ParsedWebhookBody {
  if (mediaType === '') return { ok: true, value: {} };
  const json = JSON_MEDIA_TYPE.test(mediaType);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return {
      ok: false,
      problem: json ? 'webhook.invalid_json' : 'request.invalid',
    };
  }
  if (mediaType === 'text/plain') return { ok: true, value: text };
  if (!json) return { ok: true, value: searchFields(text) };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, problem: 'webhook.invalid_json' };
  }
}
