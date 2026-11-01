import type { FederationFailureReason } from '@pertexo/contracts';

const messages: Readonly<Record<FederationFailureReason, string>> = {
  saml_unreadable:
    'The provider’s SAML response could not be read, or a required part is missing.',
  saml_destination:
    'The SAML response is addressed to a different URL. Check the callback address set at the provider.',
  saml_request:
    'The SAML response answers a different request. Start the test from this page rather than from the provider.',
  saml_issuer:
    'The SAML response came from a different issuer. Check the entity ID entered here.',
  saml_status: 'The provider reported that the sign-in did not succeed.',
  saml_assertion_count:
    'The SAML response must carry exactly one unencrypted assertion. Turn off assertion encryption at the provider.',
  saml_signature_count:
    'Both the SAML response and its assertion must be signed. Many providers sign only the assertion by default.',
  saml_signature_algorithm:
    'The SAML response uses a signature or digest method that isn’t accepted. Use SHA-256 or SHA-512.',
  saml_signature_invalid:
    'The SAML signature didn’t verify. Check that the certificate entered here is the provider’s current one.',
  saml_certificate:
    'The certificate entered here can’t be used. It must be a current RSA certificate of at least 2048 bits.',
  saml_time:
    'The SAML response is outside its valid time window. Check the provider’s clock and the assertion’s lifetime.',
  saml_audience:
    'The SAML response is meant for a different audience. Check the entity ID set at the provider.',
  saml_name_id: 'The provider must send a persistent NameID.',
  saml_subject_confirmation:
    'The SAML subject confirmation must be bearer, for this callback address and this request.',
  oidc_provider:
    'The OIDC provider couldn’t be reached, or its discovery document or client authentication isn’t usable.',
  oidc_token:
    'The OIDC provider refused the token exchange. Check the client ID, client secret and callback address.',
  oidc_email_unverified: 'The provider says this email address isn’t verified.',
  identity_claims:
    'The provider didn’t send a usable subject and email. Check the email claim or attribute name entered here.',
  email_domain:
    'The address the provider sent isn’t on the domain being tested.',
  account_refused:
    'The provider’s answer was valid, but this account can’t use it.',
  callback_invalid:
    'The provider’s answer couldn’t be read. Try the test again.',
  attempt_unavailable:
    'This test has expired or was already used. Start it again from this page.',
  test_owner:
    'The test must finish in the session that started it, signed in as the same owner.',
  unavailable: 'The test couldn’t finish. Try again in a moment.',
};

export function testFailureMessage(
  reason: FederationFailureReason | undefined,
): string {
  return reason === undefined
    ? 'Provider test did not finish. Check the provider configuration, callback address and verified domain, then try again.'
    : messages[reason];
}
