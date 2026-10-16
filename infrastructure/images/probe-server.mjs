import { createServer } from 'node:http';

// An isolated transport peer for the real nginx image, not the application API.
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://api');
  if (url.pathname === '/v1/notifications/unsubscribe/one-click') {
    if (request.method === 'GET') {
      response
        .writeHead(303, {
          location: `/notifications/unsubscribe#${url.searchParams.get('token')}`,
        })
        .end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () =>
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          method: request.method,
          body,
          token: url.searchParams.get('token'),
        }),
      ),
    );
    return;
  }
  if (request.url === '/v1/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    const timer = setTimeout(() => response.end('data: last\n\n'), 5_000);
    response.once('close', () => clearTimeout(timer));
    return;
  }
  if (request.url !== '/v1/probe') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      host: request.headers.host,
      path: request.url,
      proto: request.headers['x-forwarded-proto'],
    }),
  );
});
server.listen(3000, '0.0.0.0');
