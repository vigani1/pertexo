import { HttpResponse } from 'msw';

/**
 * Answers that confirm nothing: the server may have committed the command
 * before a proxy or the server itself gave up on the response.
 */
export const gatewayFailures = [
  [
    '502 page',
    () => new HttpResponse('<html>Bad Gateway</html>', { status: 502 }),
  ],
  ['504 without a body', () => new HttpResponse(null, { status: 504 })],
  [
    '504 problem',
    () =>
      HttpResponse.json(
        {
          type: 'urn:pertexo:problem:internal.unexpected',
          title: 'Problem',
          status: 504,
          code: 'internal.unexpected',
          requestId: 'request-gateway',
        },
        {
          status: 504,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
  ],
] as const;
