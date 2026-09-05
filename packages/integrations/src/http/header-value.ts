const NODE_HTTP_HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/u;

/** The byte-oriented field-value domain accepted by Node's HTTP serializer. */
export function isSerializableHttpHeaderValue(value: string): boolean {
  return NODE_HTTP_HEADER_VALUE.test(value);
}
