/** Approved curated-only syntax, not a URL parser, reachability or network-safety claim. */
export const CURATED_HTTPS_ENDPOINT_V1_LIMITS = Object.freeze({
  bytes: 2_048,
  hostBytes: 253,
  labelBytes: 63,
  queryPairs: 16,
  queryNameBytes: 64,
});

function validHost(host: string): boolean {
  if (host.length > CURATED_HTTPS_ENDPOINT_V1_LIMITS.hostBytes) return false;
  const labels = host.split('.');
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label) &&
        !label.startsWith('xn--'),
    ) &&
    /^[a-z]{2,63}$/u.test(labels.at(-1) ?? '')
  );
}

function validPath(path: string): boolean {
  return (
    /^\/(?:[A-Za-z0-9._~/-]|%[0-9A-F]{2})*$/u.test(path) &&
    path.split('/').every((segment) => {
      const dots = segment.replaceAll('%2E', '.');
      return dots !== '.' && dots !== '..';
    })
  );
}

function validQuery(query: string): boolean {
  const pairs = query.split('&');
  return (
    pairs.length <= CURATED_HTTPS_ENDPOINT_V1_LIMITS.queryPairs &&
    pairs.every((pair) => {
      const parsed =
        /^([A-Za-z0-9._~-]{1,64})=((?:[A-Za-z0-9._~-]|%[0-9A-F]{2})*)$/u.exec(
          pair,
        );
      return (
        parsed !== null &&
        !/(?:auth|credential|secret|token|api[-_]?key)/iu.test(parsed[1] ?? '')
      );
    })
  );
}

/** ASCII-only, bounded and pure. Never trims, decodes or normalizes submitted bytes. */
export function isCuratedHttpsEndpointV1(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > CURATED_HTTPS_ENDPOINT_V1_LIMITS.bytes ||
    /[^\x21-\x7E]/u.test(value) ||
    /[@#\\]/u.test(value) ||
    !value.startsWith('https://')
  )
    return false;
  const rest = value.slice('https://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0 || !validHost(rest.slice(0, slash))) return false;
  const suffix = rest.slice(slash);
  const question = suffix.indexOf('?');
  const path = question < 0 ? suffix : suffix.slice(0, question);
  return (
    validPath(path) && (question < 0 || validQuery(suffix.slice(question + 1)))
  );
}
