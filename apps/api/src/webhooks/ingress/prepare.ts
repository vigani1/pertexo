import { headerPresent, singleHeader } from '../requests/headers.js';
import { WEBHOOK_BODY_MAX_BYTES as MAX_BODY } from '../requests/body.js';

import { randomUUID } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { authenticationFailed, problem, record } from './reply.js';

import { parseRequestId } from '../../platform/http/index.js';
import { webhookMediaType } from '../requests/body.js';

import type {
  WebhookAcceptanceOptions,
  PreparedWebhookRequest,
} from './contract.js';

function requestMediaType(
  request: FastifyRequest,
  contentType: string | undefined,
  bodyBytes: number,
) {
  if (contentType === undefined && headerPresent(request, 'content-type'))
    return undefined;
  return webhookMediaType(contentType, bodyBytes);
}

export async function prepareWebhookRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  { method, telemetry }: Pick<WebhookAcceptanceOptions, 'method' | 'telemetry'>,
): Promise<PreparedWebhookRequest | undefined> {
  const requestId =
    parseRequestId(request.headers['x-request-id']) ?? randomUUID();
  const body =
    method === 'GET' || request.body === undefined
      ? new Uint8Array()
      : request.body;
  if (!(body instanceof Uint8Array)) {
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 'webhook.invalid_json', requestId);
    return;
  }
  if (body.byteLength > MAX_BODY) {
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 'webhook.payload_too_large', requestId);
    return;
  }
  const contentType = singleHeader(request, 'content-type');
  const mediaType =
    method === 'GET'
      ? ''
      : requestMediaType(request, contentType, body.byteLength);
  if (
    mediaType === undefined ||
    (method === 'POST' && headerPresent(request, 'content-encoding'))
  ) {
    record(() => {
      telemetry.delivery('invalid_request');
    });
    await problem(reply, 'webhook.unsupported_media_type', requestId);
    return;
  }
  const timestamp = singleHeader(request, 'x-pertexo-timestamp');
  const signature = singleHeader(request, 'x-pertexo-signature');
  const endpointKey = (request.params as { endpointKey?: unknown }).endpointKey;
  if (
    typeof endpointKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(endpointKey)
  ) {
    await authenticationFailed(reply, requestId, telemetry);
    return;
  }
  return { requestId, body, mediaType, timestamp, signature, endpointKey };
}
