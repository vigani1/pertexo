import { startWebhookPeer } from '../../apps/api/test/support/webhooks/edge-peer.mjs';

const pendingCsv = new Map();

await startWebhookPeer((request, response, rawBody) => {
  const url = new URL(request.url ?? '/', 'http://api');
  if (url.pathname === '/v1/auth/federation/social/callback/google') {
    response
      .writeHead(302, {
        location: '/workspaces',
        'set-cookie':
          'pertexo_session=synthetic_session; Path=/; HttpOnly; SameSite=Lax',
      })
      .end();
    return;
  }
  if (url.pathname === '/v1/csv-probe/release') {
    const target = pendingCsv.get(url.searchParams.get('key'));
    if (target === undefined) {
      response.writeHead(404).end();
      return;
    }
    target.destroy();
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === '/v1/csv-probe/early-failure') {
    response.destroy();
    return;
  }
  if (url.pathname === '/v1/csv-probe') {
    response.writeHead(200, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="probe.csv"',
    });
    response.write('"value"\r\n"first"\r\n');
    const failure = url.searchParams.get('fail');
    if (failure !== null) {
      pendingCsv.set(failure, response);
      response.once('close', () => pendingCsv.delete(failure));
    } else response.end(`"${'a'.repeat(2 * 1024 * 1024)}"\r\n"last"\r\n`);
    return;
  }
  if (url.pathname === '/v1/notifications/unsubscribe/one-click') {
    if (request.method === 'GET') {
      response
        .writeHead(303, {
          location: `/notifications/unsubscribe#${url.searchParams.get('token')}`,
        })
        .end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        method: request.method,
        body: rawBody.toString(),
        token: url.searchParams.get('token'),
      }),
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
