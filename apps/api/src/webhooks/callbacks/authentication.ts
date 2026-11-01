import type { CallbackStore } from '@pertexo/core/runs';
import {
  verifyWebhookSignature,
  type CallbackTokenKeys,
} from '@pertexo/integrations/server';
import type { FastifyRequest } from 'fastify';
import { verifyWebhookHeaderSecret } from '../authentication/header-secret.js';
import {
  singleHeader,
  WEBHOOK_FRESHNESS_ALLOWANCE_SECONDS,
} from '../requests/headers.js';
export function verifyCallbackRequest(
  request: FastifyRequest,
  body: Uint8Array,
  callback: NonNullable<Awaited<ReturnType<CallbackStore['resolve']>>>,
  keys: CallbackTokenKeys,
): boolean {
  const policy = callback.config.authentication;
  if (policy.mode === 'secret_url') return true;
  const secret = Buffer.from(
    keys.material(callback, callback.keyVersion).secret,
    'base64url',
  );
  try {
    if (policy.mode === 'header_secret') {
      const header = singleHeader(request, policy.headerName);
      const supplied =
        policy.headerName === 'authorization'
          ? header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/iu)?.[1]
          : header;
      return (
        supplied !== undefined && verifyWebhookHeaderSecret(secret, supplied)
      );
    }
    const timestamp = singleHeader(request, 'x-pertexo-timestamp');
    const signature = singleHeader(request, 'x-pertexo-signature');
    if (
      timestamp === undefined ||
      signature === undefined ||
      !/^\d{1,16}$/u.test(timestamp)
    )
      return false;
    const seconds = Number(timestamp);
    return (
      Number.isSafeInteger(seconds) &&
      Math.abs(callback.databaseTime.getTime() / 1000 - seconds) <=
        WEBHOOK_FRESHNESS_ALLOWANCE_SECONDS &&
      verifyWebhookSignature({ secret, timestamp, signature, rawBody: body })
    );
  } finally {
    secret.fill(0);
  }
}
