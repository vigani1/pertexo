import { createHmac } from 'node:crypto';
import http from 'node:http';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export type WebhookRequestMaterial = Readonly<{
  timestamp: string;
  signature: string;
}>;

export type BoundedWebhookResponse = Readonly<{
  status: number;
  headers: http.IncomingHttpHeaders;
  json: Record<string, unknown>;
  requestMaterial: WebhookRequestMaterial;
}>;

export function sendBoundedWebhook(
  input: Readonly<{
    endpointKey: string;
    idempotencyKey: string;
    origin: string;
    rawBody: Buffer;
    secret: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    now?: () => number;
  }>,
): Promise<BoundedWebhookResponse> {
  const timeoutMs = positiveInteger(
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'timeout',
  );
  const maxResponseBytes = positiveInteger(
    input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    'response limit',
  );
  const timestamp = String(Math.floor((input.now?.() ?? Date.now()) / 1_000));
  const signature = signatureFor(input.secret, timestamp, input.rawBody);
  const url = new URL(`/hooks/${input.endpointKey}`, input.origin);
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: http.IncomingMessage | undefined;
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(input.rawBody.byteLength),
          'idempotency-key': input.idempotencyKey,
          'x-pertexo-timestamp': timestamp,
          'x-pertexo-signature': signature,
        },
      },
      (incoming) => {
        response = incoming;
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        const onData = (chunk: Buffer | string): void => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += bytes.byteLength;
          if (receivedBytes > maxResponseBytes) {
            fail(
              new Error(
                `Webhook response exceeds ${String(maxResponseBytes)} bytes`,
              ),
              true,
            );
            return;
          }
          chunks.push(bytes);
        };
        const onEnd = (): void => {
          try {
            const bytes = Buffer.concat(chunks, receivedBytes);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(
              bytes,
            );
            const parsed =
              text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
            succeed({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              json: parsed,
              requestMaterial: { timestamp, signature },
            });
          } catch (error: unknown) {
            fail(
              new Error('Webhook response is not valid JSON', { cause: error }),
              true,
            );
          }
        };
        const onAborted = (): void => {
          fail(new Error('Webhook response was aborted'), true);
        };
        const onResponseError = (error: Error): void => {
          fail(error, true);
        };
        const onClose = (): void => {
          if (!incoming.complete)
            fail(new Error('Webhook response closed before completion'), true);
        };
        incoming.on('data', onData);
        incoming.once('end', onEnd);
        incoming.once('aborted', onAborted);
        incoming.once('error', onResponseError);
        incoming.once('close', onClose);
      },
    );
    const timeout = setTimeout(() => {
      fail(new Error(`Webhook request exceeded ${String(timeoutMs)}ms`), true);
    }, timeoutMs);
    const onRequestError = (error: Error): void => {
      fail(error, false);
    };
    request.once('error', onRequestError);
    request.end(input.rawBody);

    function succeed(value: BoundedWebhookResponse): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function fail(error: Error, destroy: boolean): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) {
        request.once('error', () => undefined);
        response?.once('error', () => undefined);
        response?.destroy();
        request.destroy();
      }
      reject(error);
    }

    function cleanup(): void {
      clearTimeout(timeout);
      request.off('error', onRequestError);
      response?.removeAllListeners('data');
      response?.removeAllListeners('end');
      response?.removeAllListeners('aborted');
      response?.removeAllListeners('error');
      response?.removeAllListeners('close');
    }
  });
}

export function signatureFor(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  return `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(timestamp, 'ascii')
    .update('.')
    .update(rawBody)
    .digest('hex')}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Webhook ${name} must be a positive integer`);
  return value;
}
