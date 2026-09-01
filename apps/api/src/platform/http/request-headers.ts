export type RequestHeaders =
  Readonly<Record<string, string | readonly string[] | undefined>> | undefined;

/** Return the case-insensitive raw header value without choosing a value policy. */
export function requestHeaderValue(
  headers: RequestHeaders,
  name: string,
): string | readonly string[] | undefined {
  if (headers === undefined) return undefined;
  const normalizedName = name.toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === normalizedName,
  );
  return key === undefined ? undefined : headers[key];
}

/** Use the first value, matching Fastify's ordinary request-header behavior. */
export function firstRequestHeader(
  headers: RequestHeaders,
  name: string,
): string | undefined {
  const value = requestHeaderValue(headers, name);
  return typeof value === 'string' ? value : value?.[0];
}

/** Accept only a scalar or an array containing exactly one string value. */
export function singleRequestHeader(
  headers: RequestHeaders,
  name: string,
): string | undefined {
  const value = requestHeaderValue(headers, name);
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}
