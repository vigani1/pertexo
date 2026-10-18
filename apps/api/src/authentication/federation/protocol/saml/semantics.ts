import { z } from 'zod';
import { SAML_LIMITS, type SamlConfiguration } from '@pertexo/contracts';
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
    return invalidSaml();
}
function notExpired(element: Element) {
  if (time(element, 'NotOnOrAfter') <= Date.now() - skew) return invalidSaml();
  if (
    element.hasAttribute('NotBefore') &&
    time(element, 'NotBefore') > Date.now() + skew
  )
    return invalidSaml();
}

export function verifyResponseSemantics(
  xml: string,
  expected: SamlExpected,
): string {
  const document = parseXml(xml),
    response = root(document, P, 'Response');
  if (
    requiredAttribute(response, 'Version') !== '2.0' ||
    requiredAttribute(response, 'Destination') !== expected.callbackUrl ||
    requiredAttribute(response, 'InResponseTo') !== expected.requestId ||
    plainText(onlyChild(response, A, 'Issuer')) !== expected.issuer ||
    requiredAttribute(
      onlyChild(onlyChild(response, P, 'Status'), P, 'StatusCode'),
      'Value',
    ) !== `${SAML}:status:Success`
  )
    return invalidSaml();
  fresh(response);
  const assertion = onlyChild(response, A, 'Assertion');
  if (
    document.getElementsByTagNameNS(A, 'Assertion').length !== 1 ||
    document.getElementsByTagNameNS(
      'http://www.w3.org/2000/09/xmldsig#',
      'Signature',
    ).length !== 2 ||
    document.getElementsByTagNameNS(A, 'EncryptedAssertion').length !== 0
  )
    return invalidSaml();
  requireModernSignature(response);
  requireModernSignature(assertion);
  return requiredAttribute(assertion, 'ID');
}
function attribute(assertion: Element, name: string): string | undefined {
  const attributes = children(assertion, A, 'AttributeStatement')
    .flatMap((statement) => children(statement, A, 'Attribute'))
    .filter((value) => value.getAttribute('Name') === name);
  if (attributes.length > 1) return invalidSaml();
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
  const assertion = root(parseXml(xml), A, 'Assertion');
  if (
    requiredAttribute(assertion, 'ID') !== assertionId ||
    requiredAttribute(assertion, 'Version') !== '2.0' ||
    plainText(onlyChild(assertion, A, 'Issuer')) !== expected.issuer
  )
    return invalidSaml();
  fresh(assertion);
  const conditions = onlyChild(assertion, A, 'Conditions');
  notExpired(conditions);
  if (time(conditions, 'NotBefore') > Date.now() + skew) return invalidSaml();
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
    return invalidSaml();
  const subject = onlyChild(assertion, A, 'Subject'),
    nameId = onlyChild(subject, A, 'NameID');
  if (
    requiredAttribute(nameId, 'Format') !== `${SAML}:nameid-format:persistent`
  )
    return invalidSaml();
  const confirmation = onlyChild(subject, A, 'SubjectConfirmation');
  if (requiredAttribute(confirmation, 'Method') !== `${SAML}:cm:bearer`)
    return invalidSaml();
  const data = onlyChild(confirmation, A, 'SubjectConfirmationData');
  if (
    requiredAttribute(data, 'Recipient') !== expected.callbackUrl ||
    requiredAttribute(data, 'InResponseTo') !== expected.requestId
  )
    return invalidSaml();
  notExpired(data);
  const authentication = onlyChild(assertion, A, 'AuthnStatement');
  if (time(authentication, 'AuthnInstant') > Date.now() + skew)
    return invalidSaml();
  if (
    authentication.hasAttribute('SessionNotOnOrAfter') &&
    time(authentication, 'SessionNotOnOrAfter') <= Date.now() - skew
  )
    return invalidSaml();
  return organizationIdentity(
    plainText(nameId),
    attribute(assertion, configuration.emailAttribute),
    attribute(assertion, configuration.nameAttribute),
  );
}
