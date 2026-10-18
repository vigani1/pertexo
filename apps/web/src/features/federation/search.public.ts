export function parseFederationSearch(
  search: Readonly<Record<string, unknown>>,
): Readonly<{ ssoTest?: 'passed' | 'failed' }> {
  return search.ssoTest === 'passed' || search.ssoTest === 'failed'
    ? { ssoTest: search.ssoTest }
    : {};
}
