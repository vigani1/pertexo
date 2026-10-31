const ENDPOINT_KEY = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The endpoint key from a pasted webhook address (…/hooks/<key>) or from the
 * bare key. Undefined when the text holds neither.
 */
export function extractEndpointKey(pasted: string): string | undefined {
  const text = pasted.trim();
  if (ENDPOINT_KEY.test(text)) return text;
  const match = /\/hooks\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/u.exec(text);
  return match?.[1];
}

/** The address senders use. /hooks is served on the app's own host. */
export function webhookAddress(endpointKey: string): string {
  return new URL(`/hooks/${endpointKey}`, window.location.origin).toString();
}

/** The same address before there is a key to show, for examples people adapt. */
export function webhookAddressTemplate(): string {
  return `${window.location.origin}/hooks/<endpoint key>`;
}
