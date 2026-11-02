import { z } from 'zod';
import {
  SAML_LIMITS,
  type FederationFailureReason,
  type SamlConfiguration,
} from '@pertexo/contracts';
import { federationFailureReason } from '../failure.js';
import { organizationIdentity } from '../identity.js';
import {
  SAML,
  SAML_ASSERTION as A,
  SAML_PROTOCOL as P,
  children,
  onlyChild,
  plainText,
  requiredAttribute,
  parseXml,
  root,
  invalidSaml,
  requireModernSignature,
} from './xml.js';

const timestamp = z.iso.datetime({ offset: true });
const skew = SAML_LIMITS.clockSkewMillis,
  maximumAge = SAML_LIMITS.assertionAgeMillis;
export type SamlExpected = Readonly<{
  requestId: string;
  issuer: string;
  audience: string;
  callbackUrl: string;
}>;
function time(element: Element, name: string): number {
  const value = requiredAttribute(element, name);
  if (!timestamp.safeParse(value).success) return invalidSaml();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : invalidSaml();
}
function fresh(element: Element) {
  const issue = time(element, 'IssueInstant'),
    now = Date.now();
  if (issue > now + skew || issue + maximumAge + skew <= now)
    return invalidSaml('saml_time');
}
function notExpired(element: Element) {
  if (time(element, 'NotOnOrAfter') <= Date.now() - skew)
    return invalidSaml('saml_time');
  if (
    element.hasAttribute('NotBefore') &&
    time(element, 'NotBefore') > Date.now() + skew
  )
    return invalidSaml('saml_time');
}

export function verifyResponseSemantics(
  xml: string,
  expected: SamlExpected,
): string {
  const document = parseXml(xml),
    response = root(document, P, 'Response');
  if (requiredAttribute(response, 'Version') !== '2.0') return invalidSaml();
  if (
    requiredAttribute(response, 'Destination', 'saml_destination') !==
    expected.callbackUrl
  )
    return invalidSaml('saml_destination');
  if (
    requiredAttribute(response, 'InResponseTo', 'saml_request') !==
    expected.requestId
  )
    return invalidSaml('saml_request');
  if (plainText(onlyChild(response, A, 'Issuer')) !== expected.issuer)
    return invalidSaml('saml_issuer');
  if (
    requiredAttribute(
      onlyChild(onlyChild(response, P, 'Status'), P, 'StatusCode'),
      'Value',
    ) !== `${SAML}:status:Success`
  )
    return invalidSaml('saml_status');
  fresh(response);
  const assertion = onlyChild(response, A, 'Assertion', 'saml_assertion_count');
  if (
    document.getElementsByTagNameNS(A, 'Assertion').length !== 1 ||
    document.getElementsByTagNameNS(A, 'EncryptedAssertion').length !== 0
  )
    return invalidSaml('saml_assertion_count');
  if (
    document.getElementsByTagNameNS(
      'http://www.w3.org/2000/09/xmldsig#',
      'Signature',
    ).length !== 2
  )
    return invalidSaml('saml_signature_count');
  requireModernSignature(response);
  requireModernSignature(assertion);
  return requiredAttribute(assertion, 'ID');
}
function attribute(assertion: Element, name: string): string | undefined {
  const attributes = children(assertion, A, 'AttributeStatement')
    .flatMap((statement) => children(statement, A, 'Attribute'))
    .filter((value) => value.getAttribute('Name') === name);
  if (attributes.length > 1) return invalidSaml('identity_claims');
  const found = attributes[0];
  return found === undefined
    ? undefined
    : plainText(onlyChild(found, A, 'AttributeValue'));
}
/** Read identity only from the assertion returned by the SDK after signature verification. */
export function verifiedAssertionIdentity(
  xml: string,
  expected: SamlExpected,
  assertionId: string,
  configuration: SamlConfiguration,
) {
  return assertionIdentity(
    root(parseXml(xml), A, 'Assertion'),
    expected,
    assertionId,
    configuration,
  );
}

/**
 * The library refuses a bad time, audience or recipient before these checks
 * run, and only says so in a message that can quote the proof. It stays refused:
 * this names what an owner should look at, by running the same checks over the
 * assertion as it was sent. Only a code comes out.
 */
export function libraryRefusalReason(
  xml: string,
  expected: SamlExpected,
  assertionId: string,
  configuration: SamlConfiguration,
): FederationFailureReason {
  const assertion = onlyChild(
    root(parseXml(xml), P, 'Response'),
    A,
    'Assertion',
  );
  try {
    assertionIdentity(assertion, expected, assertionId, configuration);
    return 'saml_signature_invalid';
  } catch (error: unknown) {
    return federationFailureReason(error);
  }
}

function assertionIdentity(
  assertion: Element,
  expected: SamlExpected,
  assertionId: string,
  configuration: SamlConfiguration,
) {
  if (
    requiredAttribute(assertion, 'ID') !== assertionId ||
    requiredAttribute(assertion, 'Version') !== '2.0'
  )
    return invalidSaml();
  if (plainText(onlyChild(assertion, A, 'Issuer')) !== expected.issuer)
    return invalidSaml('saml_issuer');
  fresh(assertion);
  const conditions = onlyChild(assertion, A, 'Conditions');
  notExpired(conditions);
  if (time(conditions, 'NotBefore') > Date.now() + skew)
    return invalidSaml('saml_time');
  const restrictions = children(conditions, A, 'AudienceRestriction');
  if (
    restrictions.length === 0 ||
    restrictions.some(
      (restriction) =>
        !children(restriction, A, 'Audience').some(
          (audience) => plainText(audience) === expected.audience,
        ),
    )
  )
    return invalidSaml('saml_audience');
  const subject = onlyChild(assertion, A, 'Subject'),
    nameId = onlyChild(subject, A, 'NameID', 'saml_name_id');
  if (
    requiredAttribute(nameId, 'Format', 'saml_name_id') !==
    `${SAML}:nameid-format:persistent`
  )
    return invalidSaml('saml_name_id');
  const confirmation = onlyChild(subject, A, 'SubjectConfirmation');
  if (requiredAttribute(confirmation, 'Method') !== `${SAML}:cm:bearer`)
    return invalidSaml('saml_subject_confirmation');
  const data = onlyChild(confirmation, A, 'SubjectConfirmationData');
  if (
    requiredAttribute(data, 'Recipient') !== expected.callbackUrl ||
    requiredAttribute(data, 'InResponseTo') !== expected.requestId
  )
    return invalidSaml('saml_subject_confirmation');
  notExpired(data);
  const authentication = onlyChild(assertion, A, 'AuthnStatement');
  if (time(authentication, 'AuthnInstant') > Date.now() + skew)
    return invalidSaml('saml_time');
  if (
    authentication.hasAttribute('SessionNotOnOrAfter') &&
    time(authentication, 'SessionNotOnOrAfter') <= Date.now() - skew
  )
    return invalidSaml('saml_time');
  return organizationIdentity(
    plainText(nameId),
    attribute(assertion, configuration.emailAttribute),
    attribute(assertion, configuration.nameAttribute),
  );
}
