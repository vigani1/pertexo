import {
  WEBHOOK_RESPONSE_MAX_BYTES,
  type NodeWebhookResponse,
} from '@pertexo/node-sdk';
import { InvalidBoundedJsonError } from '@pertexo/node-sdk/server';
import type {
  CoreRespondWebhookConfig,
  CoreRespondWebhookInput,
} from './validation.js';

export function serializeWebhookResponse(
  config: CoreRespondWebhookConfig,
  input: CoreRespondWebhookInput,
): NodeWebhookResponse {
  const bodyType = config.bodyType ?? 'json';
  const statusCode = input.statusCode ?? 200;
  let body: string;
  if (bodyType === 'json') body = JSON.stringify(input.body);
  else {
    if (typeof input.body !== 'string')
      throw new InvalidBoundedJsonError(
        'A text webhook response needs a text body.',
      );
    body = input.body;
  }
  if (body.includes('\u0000'))
    throw new InvalidBoundedJsonError(
      'A text webhook response cannot contain a null character. Use JSON to encode it.',
    );
  if (new TextEncoder().encode(body).byteLength > WEBHOOK_RESPONSE_MAX_BYTES)
    throw new InvalidBoundedJsonError(
      'The webhook response exceeds 1 MB. Send a smaller response.',
    );
  if (
    [204, 205, 304].includes(statusCode) &&
    (bodyType !== 'text' || body !== '')
  )
    throw new InvalidBoundedJsonError(
      'Status 204, 205 and 304 require an empty text response.',
    );
  return {
    statusCode,
    contentType:
      bodyType === 'json'
        ? 'application/json'
        : (config.textContentType ?? 'text/plain'),
    headers: Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    ),
    body,
  };
}
