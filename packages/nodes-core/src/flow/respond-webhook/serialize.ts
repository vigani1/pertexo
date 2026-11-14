import { utf8ByteLength } from '@pertexo/workflow-model';
import {
  formatByteSize,
  WEBHOOK_RESPONSE_MAX_BYTES,
  type NodeWebhookResponse,
} from '@pertexo/node-sdk';
import { InvalidBoundedJsonError } from '@pertexo/node-sdk/server';
import type {
  CoreRespondWebhookConfig,
  CoreRespondWebhookInput,
} from './respond-webhook.schemas.js';

const DEFAULT_STATUS = 200;
// HTTP statuses that carry no body.
const NO_CONTENT_STATUSES: readonly number[] = Object.freeze([204, 205, 304]);

export function serializeWebhookResponse(
  config: CoreRespondWebhookConfig,
  input: CoreRespondWebhookInput,
): NodeWebhookResponse {
  const bodyType = config.bodyType ?? 'json';
  const statusCode = input.statusCode ?? DEFAULT_STATUS;
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
  if (utf8ByteLength(body) > WEBHOOK_RESPONSE_MAX_BYTES)
    throw new InvalidBoundedJsonError(
      `The webhook response exceeds ${formatByteSize(WEBHOOK_RESPONSE_MAX_BYTES)}. Send a smaller response.`,
    );
  if (
    NO_CONTENT_STATUSES.includes(statusCode) &&
    (bodyType !== 'text' || body !== '')
  )
    throw new InvalidBoundedJsonError(
      `Status ${NO_CONTENT_STATUSES.join(', ').replace(/, (?=\d+$)/u, ' and ')} require an empty text response.`,
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
