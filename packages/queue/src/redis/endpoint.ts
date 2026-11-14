export type RedisEndpointErrorReason = 'invalid_url' | 'unsupported_endpoint';

/** What every queue client says about a Redis URL it can't use. */
export const REDIS_ENDPOINT_ERROR_MESSAGE = Object.freeze({
  invalid_url: 'Redis URL is invalid',
  unsupported_endpoint:
    'Redis URL must use redis:// or rediss:// with a hostname',
} satisfies Record<RedisEndpointErrorReason, string>);

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
