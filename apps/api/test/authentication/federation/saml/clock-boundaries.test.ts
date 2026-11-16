import { XMLSerializer } from '@xmldom/xmldom';
import { X509Certificate } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { SAML_LIMITS } from '@pertexo/contracts';
import { validateSamlCertificates } from '../../../../src/authentication/federation/protocol/saml/configuration.js';
import {
  verifiedAssertionIdentity,
  verifyResponseSemantics,
} from '../../../../src/authentication/federation/protocol/saml/semantics.js';
import {
  parseXml,
  root,
  onlyChild,
  SAML_PROTOCOL,
  SAML_ASSERTION,
} from '../../../../src/authentication/federation/protocol/saml/xml.js';
import {
  signingMaterial,
  samlFixture,
  type SigningMaterial,
  type ResponseOptions,
} from './saml-sign-in.fixture.js';
let material: SigningMaterial;
beforeAll(() => {
  material = signingMaterial();
});
it.each(['validFrom', 'validTo'] as const)(
  'checks the certificate %s boundary with the supplied clock',
  (edge) => {
    const fixture = samlFixture(material);
    const threshold = Date.parse(
      new X509Certificate(material.certificate)[edge],
    );
    for (const offset of [-1, 1]) {
      const check = () =>
        validateSamlCertificates(
          fixture.provider.configuration,
          () => threshold + offset,
        );
      if ((edge === 'validFrom') === offset > 0)
        expect(check()).toHaveLength(1);
      else expect(check).toThrow();
    }
  },
);
it.each(['notBefore', 'expiresAt', 'issuedAt', 'authnInstant'] as const)(
  'checks assertion %s skew with the supplied clock',
  (field) => {
    const fixture = samlFixture(material);
    const instant = Date.parse('2030-01-01T12:00:00Z');
    const boundary =
      field === 'expiresAt'
        ? instant - SAML_LIMITS.clockSkewMillis
        : instant + SAML_LIMITS.clockSkewMillis;
    for (const offset of [-1, 1]) {
      const options: ResponseOptions = {
        issuedAt: new Date(instant).toISOString(),
        notBefore: new Date(instant - 1000).toISOString(),
        expiresAt: new Date(instant + 60000).toISOString(),
        authnInstant: new Date(instant).toISOString(),
        [field]: new Date(boundary + offset).toISOString(),
      };
      const xml = Buffer.from(fixture.response(options), 'base64').toString();
      const assertion = new XMLSerializer().serializeToString(
        onlyChild(
          root(parseXml(xml), SAML_PROTOCOL, 'Response'),
          SAML_ASSERTION,
          'Assertion',
        ),
      );
      const expected = {
        requestId: fixture.proof.requestId,
        issuer: fixture.provider.issuer,
        audience: fixture.proof.entityId,
        callbackUrl: fixture.proof.redirectUri,
      };
      const check = () =>
        verifiedAssertionIdentity(
          assertion,
          { ...expected, assertionId: '_assertion' },
          fixture.provider.configuration,
          () => instant,
        );
      if ((field === 'expiresAt') === offset > 0)
        expect(check()).toHaveProperty('subject', 'immutable-person');
      else expect(check).toThrow();
    }
  },
);
it('expires response freshness at the maximum age plus skew', () => {
  const fixture = samlFixture(material);
  const issued = Date.parse('2030-01-01T12:00:00Z');
  const xml = Buffer.from(
    fixture.response({ issuedAt: new Date(issued).toISOString() }),
    'base64',
  ).toString();
  const expected = {
    requestId: fixture.proof.requestId,
    issuer: fixture.provider.issuer,
    audience: fixture.proof.entityId,
    callbackUrl: fixture.proof.redirectUri,
  };
  const threshold =
    issued + SAML_LIMITS.assertionAgeMillis + SAML_LIMITS.clockSkewMillis;
  expect(verifyResponseSemantics(xml, expected, () => threshold - 1)).toBe(
    '_assertion',
  );
  expect(() =>
    verifyResponseSemantics(xml, expected, () => threshold + 1),
  ).toThrow();
});

it('checks an assertion session expiry across the skew boundary', () => {
  const fixture = samlFixture(material);
  const instant = Date.parse('2030-01-01T12:00:00Z');
  for (const offset of [-1, 1]) {
    const xml = Buffer.from(
      fixture.response({
        issuedAt: new Date(instant).toISOString(),
        notBefore: new Date(instant - 1000).toISOString(),
        expiresAt: new Date(instant + 60000).toISOString(),
        authnInstant: new Date(instant).toISOString(),
      }),
      'base64',
    ).toString();
    const assertion = new XMLSerializer()
      .serializeToString(
        onlyChild(
          root(parseXml(xml), SAML_PROTOCOL, 'Response'),
          SAML_ASSERTION,
          'Assertion',
        ),
      )
      .replace(
        '<saml:AuthnStatement ',
        `<saml:AuthnStatement SessionNotOnOrAfter="${new Date(instant - SAML_LIMITS.clockSkewMillis + offset).toISOString()}" `,
      );
    const expected = {
      requestId: fixture.proof.requestId,
      issuer: fixture.provider.issuer,
      audience: fixture.proof.entityId,
      callbackUrl: fixture.proof.redirectUri,
    };
    const check = () =>
      verifiedAssertionIdentity(
        assertion,
        { ...expected, assertionId: '_assertion' },
        fixture.provider.configuration,
        () => instant,
      );
    if (offset > 0)
      expect(check()).toHaveProperty('subject', 'immutable-person');
    else expect(check).toThrow();
  }
});
