import { createServer, type RequestListener, type Server } from 'node:http';

/**
 * The loopback listener a browser journey's Playwright process reports to.
 *
 * Every answer closes its connection. Playwright's request context keeps idle
 * sockets for reuse, while Node closes an idle server socket after
 * `keepAliveTimeout` plus its buffer (6 s). A report sent on a reused socket in
 * the moment the server closes it fails with ECONNRESET, and a POST is never
 * retried. Without keep-alive no socket is ever reused, so the race cannot
 * happen; a journey makes a few dozen reports, so new connections cost nothing.
 */
export function createControlListener(handle: RequestListener): Server {
  return createServer((request, response) => {
    response.shouldKeepAlive = false;
    handle(request, response);
  });
}
