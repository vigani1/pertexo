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

/** The address senders use; the API origin isn't known to the browser yet. */
export const WEBHOOK_URL_TEMPLATE =
  '<your Pertexo API address>/hooks/<endpoint key>';

export function webhookPath(endpointKey: string): string {
  return `/hooks/${endpointKey}`;
}
