import { createHmac } from 'node:crypto';

import { request as sendHttpRequest } from 'node:http';

import type { FastifyInstance } from 'fastify';

import { endpointKey, currentSecret, timestamp } from './environment.js';

export function request(body: string, secret: Uint8Array) {
  return {
    method: 'POST' as const,
    url: `/hooks/${endpointKey}`,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-pertexo-timestamp': timestamp,
      'x-pertexo-signature': signature(body, secret),
      'idempotency-key': 'delivery-1',
    },
    payload: body,
  };
}

export function signature(
  body: string | Uint8Array,
  secret: Uint8Array,
): string {
  return `v1=${createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest('hex')}`;
}

export function rawHeaders(body: string): string[] {
  return [
    'host',
    '127.0.0.1',
    'content-type',
    'application/json',
    'x-pertexo-timestamp',
    timestamp,
    'x-pertexo-signature',
    signature(body, currentSecret),
    'idempotency-key',
    'delivery-1',
    'content-length',
    String(Buffer.byteLength(body)),
  ];
}

export function removeRawHeader(
  headers: readonly string[],
  name: string,
): string[] {
  const output: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === name) continue;
    output.push(headers[index] ?? '', headers[index + 1] ?? '');
  }
  return output;
}

export function replaceRawHeader(
  headers: readonly string[],
  name: string,
  value: string,
): string[] {
  const output = [...headers];
  const index = output.findIndex(
    (entry, position) => position % 2 === 0 && entry.toLowerCase() === name,
  );
  if (index < 0) throw new Error(`Raw header ${name} is missing`);
  output[index + 1] = value;
  return output;
}

export async function sendRawWebhook(
  application: FastifyInstance,
  headers: readonly string[],
  body: string,
): Promise<Readonly<{ statusCode: number; body: string }>> {
  if (!application.server.listening)
    await application.listen({ host: '127.0.0.1', port: 0 });
  const address = application.server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected a TCP listening address');
  return new Promise((resolve, reject) => {
    const client = sendHttpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: `/hooks/${endpointKey}`,
        headers: [...headers],
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    client.once('error', reject);
    client.end(body);
  });
}
