import {
  federationFailureReasonSchema,
  type FederationFailureReason,
} from '@pertexo/contracts';

export type FederationSection = 'sign-in' | 'directory';
export function parseFederationSearch(
  search: Readonly<Record<string, unknown>>,
): Readonly<{
  ssoTest?: 'passed' | 'failed';
  ssoReason?: FederationFailureReason;
  ssoSection?: FederationSection;
}> {
  const reason = federationFailureReasonSchema.safeParse(search.ssoReason);
  return {
    ...(search.ssoTest === 'passed' || search.ssoTest === 'failed'
      ? { ssoTest: search.ssoTest }
      : {}),
    ...(reason.success ? { ssoReason: reason.data } : {}),
    ...(search.ssoSection === 'sign-in' || search.ssoSection === 'directory'
      ? { ssoSection: search.ssoSection }
      : {}),
  };
}
