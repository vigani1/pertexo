export type FederationSection = 'sign-in' | 'directory';
export function parseFederationSearch(
  search: Readonly<Record<string, unknown>>,
): Readonly<{ ssoTest?: 'passed' | 'failed'; ssoSection?: FederationSection }> {
  return {
    ...(search.ssoTest === 'passed' || search.ssoTest === 'failed'
      ? { ssoTest: search.ssoTest }
      : {}),
    ...(search.ssoSection === 'sign-in' || search.ssoSection === 'directory'
      ? { ssoSection: search.ssoSection }
      : {}),
  };
}
