/** Test-only replacement of Slack transport; parsing/classification stays real. */
export function createConnectionHealthSlackTransport(controlOrigin) {
  const origin = new URL(controlOrigin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1')
    throw new Error('Controlled Slack requires an owned loopback origin');
  return {
    async execute(request) {
      if (
        ![
          'Bearer xoxb-owned-fixture-token-1',
          'Bearer xoxb-owned-fixture-token-2',
        ].includes(request.headers?.authorization)
      )
        throw new Error('Controlled Slack credential identity mismatch');
      const endpoint = new URL(request.url);
      if (
        endpoint.origin !== 'https://slack.com' ||
        !['/api/auth.test', '/api/chat.postMessage'].includes(endpoint.pathname)
      )
        throw new Error(
          'External provider access prohibited in health fixture',
        );
      await request.beforeDispatch?.();
      const response = await fetch(new URL(endpoint.pathname, origin), {
        method: 'POST',
        signal: AbortSignal.any([
          AbortSignal.timeout(request.timeoutMillis),
          ...(request.signal === undefined ? [] : [request.signal]),
        ]),
        redirect: 'error',
      });
      return {
        status: response.status,
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array(await response.arrayBuffer()),
        bodyEncoding: 'utf8',
        finalUrl: request.url,
        redirectCount: 0,
      };
    },
  };
}
