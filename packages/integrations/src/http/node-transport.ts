import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

import type { ResolvedAddress } from './address-policy.js';
import type {
  SecureHttpResolver,
  SecureHttpTransport,
  SecureHttpTransportRequest,
  SecureHttpTransportResponse,
} from './secure-http.js';
import { SecureHttpClient } from './secure-http.js';

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
      const requestFunction =
        input.url.protocol === 'https:' ? https.request : http.request;
      const request = requestFunction(
        input.url,
        {
          agent: false,
          headers: input.headers,
          lookup: pinnedLookup,
          maxHeaderSize: 32_768,
          method: input.method,
          signal: input.signal,
        },
        (response) => {
          resolve(
            Object.freeze({
              status: response.statusCode ?? 0,
              headers: Object.freeze({ ...response.headers }),
              body: response,
              close: (): void => {
                response.destroy();
              },
            }),
          );
        },
      );
      request.setTimeout(input.timeoutMillis, () => {
        const error = new Error('Secure HTTP request timed out');
        Object.assign(error, { code: 'ETIMEDOUT' });
        request.destroy(error);
      });
      request.once('error', reject);
      if (input.body !== undefined) request.write(input.body);
      request.end();
    });
  }
}

export function createNodeSecureHttpClient(): SecureHttpClient {
  return new SecureHttpClient(new NodeDnsResolver(), new NodeHttpTransport());
}
