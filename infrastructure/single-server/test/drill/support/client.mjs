import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * A browser stand-in: keeps cookies, sends the CSRF header and the origin. The
 * public name is resolved to `connect` because the drill has no real DNS.
 */
export function createClient({ origin, connect, ca }) {
  const cookies = new Map();
  const call = (method, target, options = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(target, origin);
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const body =
        options.body === undefined
          ? undefined
          : Buffer.isBuffer(options.body)
            ? options.body
            : JSON.stringify(options.body);
      const mutating = method !== 'GET' && method !== 'HEAD';
      const sameOrigin =
        !options.anonymous && url.origin === new URL(origin).origin;
      const request = send(
        {
          host: connect?.host ?? url.hostname,
          port: connect?.port ?? url.port,
          servername: url.hostname,
          ca,
          method,
          path: url.pathname + url.search,
          headers: {
            host: url.host,
            ...(sameOrigin && cookies.size
              ? {
                  cookie: [...cookies]
                    .map(([key, value]) => `${key}=${value}`)
                    .join('; '),
                }
              : {}),
            ...(sameOrigin && mutating ? { origin } : {}),
            ...(sameOrigin && mutating && cookies.has('pertexo_csrf')
              ? {
                  'x-csrf-token': decodeURIComponent(
                    cookies.get('pertexo_csrf'),
                  ),
                }
              : {}),
            ...(body !== undefined && !Buffer.isBuffer(body)
              ? { 'content-type': 'application/json' }
              : {}),
            ...(body !== undefined
              ? { 'content-length': Buffer.byteLength(body) }
              : {}),
            ...options.headers,
          },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () => {
            if (sameOrigin)
              for (const line of response.headers['set-cookie'] ?? []) {
                const [pair] = line.split(';');
                const split = pair.indexOf('=');
                const key = pair.slice(0, split);
                const value = pair.slice(split + 1);
                if (value === '' || /max-age=0/iu.test(line))
                  cookies.delete(key);
                else cookies.set(key, value);
              }
            const bytes = Buffer.concat(chunks);
            const text = bytes.toString();
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              // Pages and file bytes aren't JSON.
            }
            resolve({
              status: response.statusCode,
              headers: response.headers,
              bytes,
              text,
              json,
            });
          });
        },
      );
      request.setTimeout(options.timeout ?? 30_000, () =>
        request.destroy(new Error(`${method} ${target} timed out`)),
      );
      request.once('error', reject);
      request.end(body);
    });
  const withIdempotency = (headers) => ({
    'idempotency-key': randomUUID(),
    ...headers,
  });
  return {
    get: (target, options) => call('GET', target, options),
    post: (target, body, options) =>
      call('POST', target, {
        ...options,
        body,
        headers: withIdempotency(options?.headers),
      }),
    put: (target, body, options) =>
      call('PUT', target, {
        ...options,
        body,
        headers: withIdempotency(options?.headers),
      }),
    /** A caller with no session, like a webhook sender or a presigned transfer. */
    anonymous: (method, target, body, headers) =>
      call(method, target, {
        anonymous: true,
        body:
          body === undefined || Buffer.isBuffer(body)
            ? body
            : Buffer.from(JSON.stringify(body)),
        headers,
      }),
  };
}
