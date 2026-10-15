import { observeMultipart } from './multipart-observation.js';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { Socket } from 'node:net';
import {
  SecureHttpClient,
  type SecureHttpTransportRequest,
  type SecureHttpTransportResponse,
} from '@pertexo/integrations/server';

export const artifactDestinationUrl =
  'https://artifact-owned.example.test/upload';
const address = '8.8.8.8';
const authorization = 'Bearer owned-artifact-destination';

/** A real loopback exchange reachable only through this exact test transport. */
export async function createArtifactDestination(
  onEffect: () => void = () => undefined,
) {
  const observations: {
    byteLength: number;
    sha256: string;
    mediaType: string | undefined;
  }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      if (
        incoming.method !== 'POST' ||
        incoming.url !== '/upload' ||
        incoming.headers.authorization !== authorization
      ) {
        outgoing.writeHead(403).end();
        return;
      }
      const hash = createHash('sha256');
      const multipart =
        incoming.headers['content-type']?.startsWith('multipart/form-data;') ===
        true;
      const chunks: Buffer[] = [];
      let byteLength = 0;
      for await (const value of incoming) {
        const chunk: unknown = value;
        if (!(chunk instanceof Uint8Array))
          throw new Error('Invalid destination bytes');
        byteLength += chunk.byteLength;
        if (byteLength > 1048576)
          throw new Error('Destination byte limit exceeded');
        hash.update(chunk);
        if (multipart) chunks.push(Buffer.from(chunk));
      }
      observations.push({
        byteLength,
        sha256: hash.digest('hex'),
        mediaType: incoming.headers['content-type'],
      });
      onEffect();
      const response = multipart
        ? await observeMultipart(
            Buffer.concat(chunks),
            incoming.headers['content-type'] ?? '',
          )
        : {};
      outgoing
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(response));
    })().catch(() => {
      if (!outgoing.destroyed) outgoing.writeHead(400).end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const target = server.address();
  if (target === null || typeof target === 'string')
    throw new Error('Destination did not bind');
  const dispatch = (
    input: SecureHttpTransportRequest,
  ): Promise<SecureHttpTransportResponse> => {
    if (
      input.url.href !== artifactDestinationUrl ||
      input.address.address !== address ||
      input.method !== 'POST' ||
      input.body === undefined ||
      input.body.byteLength > 1048576 ||
      input.signal?.aborted === true
    )
      return Promise.reject(new Error('Destination outside owned fixture'));
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: '127.0.0.1',
          port: target.port,
          method: 'POST',
          path: '/upload',
          headers: {
            ...input.headers,
            'content-length': input.body?.byteLength,
          },
          signal: input.signal,
        },
        (incoming) => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: incoming,
            close: () => {
              incoming.destroy();
              outgoing.destroy();
            },
          });
        },
      );
      outgoing.setTimeout(input.timeoutMillis, () =>
        outgoing.destroy(new Error('Destination timed out')),
      );
      outgoing.once('error', reject);
      outgoing.end(input.body);
    });
  };
  return {
    authorization,
    httpClient: new SecureHttpClient(
      {
        resolve: (hostname) =>
          hostname === new URL(artifactDestinationUrl).hostname
            ? Promise.resolve([{ address, family: 4 }])
            : Promise.reject(new Error('Outside owned DNS')),
      },
      { dispatch },
    ),
    observe: () => observations.map((value) => ({ ...value })),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    },
  };
}
