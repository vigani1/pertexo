import { createServer } from 'node:http';

// An isolated transport peer for the real nginx image, not the application API.
const server = createServer((request, response) => {
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
