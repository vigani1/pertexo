/** Header bounds for every header a step or connection sends. */
export const HTTP_HEADER_LIMITS = Object.freeze({
  nameCharacters: 128,
  valueCharacters: 8_192,
  credentialHeaders: 32,
  credentialHeaderBytes: 16_384,
});

const NODE_HTTP_FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/u;

/** Browser-safe projection of the field-value bytes accepted by Node HTTP. */
export function isSupportedHttpFieldValue(value: string): boolean {
  return NODE_HTTP_FIELD_VALUE.test(value);
}
