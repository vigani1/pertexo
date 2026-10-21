import { FILE_TRANSFER_NO_PROGRESS_MILLIS } from '@pertexo/node-sdk';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Transform, pipeline, type Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';

import type { ResolvedAddress } from './address-policy.js';
import type {
  SecureHttpResolver,
  SecureHttpTransport,
  SecureHttpTransportRequest,
  SecureHttpTransportResponse,
} from '../secure.js';
import { SecureHttpClient, type SecureHttpAddressPolicy } from '../secure.js';

export class NodeDnsResolver implements SecureHttpResolver {
  public async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return Object.freeze(
      answers.map((answer) =>
        Object.freeze({
          address: answer.address,
          family: answer.family === 6 ? (6 as const) : (4 as const),
        }),
      ),
    );
  }
}

export class NodeHttpTransport implements SecureHttpTransport {
  public dispatch(
    input: SecureHttpTransportRequest,
  ): Promise<SecureHttpTransportResponse> {
    return new Promise((resolve, reject) => {
      const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [input.address]);
          return;
        }
        callback(null, input.address.address, input.address.family);
      };
      let response: http.IncomingMessage | undefined;
      let source: Readable | undefined;
      let uploadFinished = false;
      let settled = false;
      const fail = (error: Error): void => {
        source?.destroy(error);
        response?.destroy();
        if (!request.destroyed) request.destroy(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const complete = (): void => {
        if (settled || !uploadFinished || response === undefined) return;
        settled = true;
        const received = response;
        resolve(
          Object.freeze({
            status: received.statusCode ?? 0,
            headers: Object.freeze({ ...received.headers }),
            body: received,
            close: (): void => {
              received.destroy();
            },
          }),
        );
      };
      const requestFunction =
        input.url.protocol === 'https:' ? https.request : http.request;
      const request = requestFunction(
        input.url,
        {
          agent: false,
          headers: {
            ...input.headers,
            ...(input.body === undefined
              ? {}
              : { 'content-length': String(input.body.byteLength) }),
          },
          lookup: pinnedLookup,
          maxHeaderSize: 32_768,
          method: input.method,
          signal: input.signal,
        },
        (received) => {
          response = received;
          received.on('error', fail);
          complete();
        },
      );
      const fileTransfer =
        input.body !== undefined && !(input.body instanceof Uint8Array);
      request.setTimeout(
        fileTransfer
          ? Math.min(input.timeoutMillis, FILE_TRANSFER_NO_PROGRESS_MILLIS)
          : input.timeoutMillis,
        () => {
          const error = Object.assign(
            new Error('Secure HTTP request timed out'),
            { code: 'ETIMEDOUT' },
          );
          fail(error);
        },
      );
      request.on('error', fail);
      request.once('finish', () => {
        uploadFinished = true;
        complete();
      });
      if (input.body === undefined || input.body instanceof Uint8Array) {
        request.end(input.body);
        return;
      }
      const length = input.body.byteLength;
      let written = 0;
      const counter = new Transform({
        readableHighWaterMark: 65536,
        writableHighWaterMark: 65536,
        transform(chunk: unknown, _encoding, callback) {
          if (
            !(chunk instanceof Uint8Array) ||
            written + chunk.byteLength > length
          ) {
            callback(new Error('Verified HTTP body length mismatch'));
            return;
          }
          written += chunk.byteLength;
          callback(null, chunk);
        },
        flush(callback) {
          callback(
            written === length
              ? undefined
              : new Error('Verified HTTP body length mismatch'),
          );
        },
      });
      try {
        source = input.body.open(input.signal ?? new AbortController().signal);
        pipeline(source, counter, request, (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error('Verified HTTP body could not be opened'),
        );
      }
    });
  }
}

export function createNodeSecureHttpClient(
  addressPolicy?: SecureHttpAddressPolicy,
): SecureHttpClient {
  return new SecureHttpClient(
    new NodeDnsResolver(),
    new NodeHttpTransport(),
    undefined,
    addressPolicy,
  );
}
