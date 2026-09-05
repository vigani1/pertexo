const NODE_HTTP_FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/u;

/** Browser-safe projection of the field-value bytes accepted by Node HTTP. */
export function isSupportedHttpFieldValue(value: string): boolean {
  return NODE_HTTP_FIELD_VALUE.test(value);
}
