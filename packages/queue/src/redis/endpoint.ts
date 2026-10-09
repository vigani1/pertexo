export type RedisEndpointErrorReason = 'invalid_url' | 'unsupported_endpoint';

export function normalizeRedisEndpoint(
  value: string,
  failure: (reason: RedisEndpointErrorReason) => Error,
): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw failure('invalid_url');
  }
  if (
    (endpoint.protocol !== 'redis:' && endpoint.protocol !== 'rediss:') ||
    endpoint.hostname.length === 0
  )
    throw failure('unsupported_endpoint');

  endpoint.hostname = endpoint.hostname.toLowerCase();
  if (endpoint.pathname.length === 0) endpoint.pathname = '/';
  return endpoint.href;
}
