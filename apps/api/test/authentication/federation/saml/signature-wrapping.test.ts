import { beforeAll, describe, expect, it } from 'vitest';

import { federationFailureReason } from '../../../../src/authentication/federation/protocol/failure.js';
import { createSamlProofGateway } from '../../../../src/authentication/federation/protocol/saml/gateway.js';
import {
  samlFixture,
  signingMaterial,
  type SigningMaterial,
} from './fixture.js';

const gateway = createSamlProofGateway();
let material: SigningMaterial;
beforeAll(() => {
  material = signingMaterial();
});

const ATTACKER = 'attacker@example.test';
const VICTIM = 'victim-admin@example.test';

/**
 * What an attacker has: a response the identity provider really signed, for
 * themselves. What they want: to sign in as someone else by moving that signed
 * part out of the way, so a verifier checks one assertion and reads another.
 */
function genuine() {
  const fixture = samlFixture(material);
  const xml = Buffer.from(
    fixture.response({ email: ATTACKER, subject: 'attacker-person' }),
    'base64',
  ).toString();
  return { fixture, xml };
}

function parts(xml: string) {
  const assertion = /<saml:Assertion[\s\S]*<\/saml:Assertion>/u.exec(xml)?.[0];
  if (assertion === undefined) throw new Error('No assertion in the fixture');
  const responseSignature =
    /<samlp:Response[^>]*>[\s\S]*?(<(?:ds:)?Signature[\s\S]*?<\/(?:ds:)?Signature>)/u.exec(
      xml.replace(assertion, ''),
    )?.[1];
  if (responseSignature === undefined)
    throw new Error('No response signature in the fixture');
  const assertionSignature =
    /<(?:ds:)?Signature[\s\S]*?<\/(?:ds:)?Signature>/u.exec(assertion)?.[0];
  if (assertionSignature === undefined)
    throw new Error('No assertion signature in the fixture');
  const forged = assertion
    .replace(assertionSignature, '')
    .replace('ID="_assertion"', 'ID="_forged"')
    .replaceAll(ATTACKER, VICTIM)
    .replaceAll('attacker-person', 'victim-person');
  return { assertion, assertionSignature, responseSignature, forged };
}

const WRAPS: readonly (readonly [string, (xml: string) => string])[] = [
  [
    'XSW1: a forged response around the signed one, kept inside the copied signature',
    (xml) => {
      const { assertion, responseSignature, forged } = parts(xml);
      const original = xml;
      const signature = responseSignature.replace(
        /<\/((?:ds:)?)Signature>$/u,
        `<$1Object>${original}</$1Object></$1Signature>`,
      );
      return xml
        .replace(assertion, forged)
        .replace(responseSignature, signature)
        .replace('ID="_response"', 'ID="_forged_response"');
    },
  ],
  [
    'XSW2: a forged response with the signed one detached beside the signature',
    (xml) => {
      const { assertion, responseSignature, forged } = parts(xml);
      return xml
        .replace(assertion, forged)
        .replace(responseSignature, `${xml}${responseSignature}`)
        .replace('ID="_response"', 'ID="_forged_response"');
    },
  ],
  [
    'XSW3: a forged assertion ahead of the signed one',
    (xml) => {
      const { assertion, forged } = parts(xml);
      return xml.replace(assertion, `${forged}${assertion}`);
    },
  ],
  [
    'XSW4: a forged assertion wrapped around the signed one',
    (xml) => {
      const { assertion, forged } = parts(xml);
      return xml.replace(
        assertion,
        forged.replace('</saml:Assertion>', `${assertion}</saml:Assertion>`),
      );
    },
  ],
  [
    'XSW5: a forged assertion wearing the signature, the signed one after it',
    (xml) => {
      const { assertion, assertionSignature, forged } = parts(xml);
      return xml.replace(
        assertion,
        `${forged.replace('</saml:Assertion>', `${assertionSignature}</saml:Assertion>`)}${assertion.replace(assertionSignature, '')}`,
      );
    },
  ],
  [
    'XSW6: a forged assertion wearing the signature, with the signed one inside it',
    (xml) => {
      const { assertion, assertionSignature, forged } = parts(xml);
      const signature = assertionSignature.replace(
        /<\/((?:ds:)?)Signature>$/u,
        `<$1Object>${assertion.replace(assertionSignature, '')}</$1Object></$1Signature>`,
      );
      return xml.replace(
        assertion,
        forged.replace('</saml:Assertion>', `${signature}</saml:Assertion>`),
      );
    },
  ],
  [
    'XSW7: the signed assertion hidden in Extensions, the forged one where it was',
    (xml) => {
      const { assertion, forged } = parts(xml);
      return xml.replace(
        assertion,
        `<samlp:Extensions>${assertion}</samlp:Extensions>${forged}`,
      );
    },
  ],
  [
    'XSW8: the signed assertion hidden in the signature of a forged one',
    (xml) => {
      const { assertion, assertionSignature, forged } = parts(xml);
      const signature = assertionSignature.replace(
        /<\/((?:ds:)?)Signature>$/u,
        `<$1Object>${assertion}</$1Object></$1Signature>`,
      );
      return xml.replace(
        assertion,
        forged.replace('</saml:Assertion>', `${signature}</saml:Assertion>`),
      );
    },
  ],
  [
    'the signed assertion hidden in Extensions, with nothing in its place',
    (xml) => {
      const { assertion } = parts(xml);
      return xml.replace(
        assertion,
        `<samlp:Extensions>${assertion}</samlp:Extensions>`,
      );
    },
  ],
  [
    'an encrypted assertion beside the signed one',
    (xml) => {
      const { assertion } = parts(xml);
      return xml.replace(
        assertion,
        `<saml:EncryptedAssertion>x</saml:EncryptedAssertion>${assertion}`,
      );
    },
  ],
  [
    'a forged assertion under an unexpected namespace prefix',
    (xml) => {
      const { assertion, forged } = parts(xml);
      const prefixed = forged
        .replaceAll('<saml:', '<other:')
        .replaceAll('</saml:', '</other:')
        .replace('xmlns:saml=', 'xmlns:other=');
      return xml.replace(assertion, `${prefixed}${assertion}`);
    },
  ],
];

const refusal = (fixture: ReturnType<typeof samlFixture>, xml: string) =>
  gateway
    .verify(
      fixture.provider,
      fixture.proof,
      Buffer.from(xml).toString('base64'),
    )
    .then(
      (identity) => ({ signedInAs: identity.email }),
      (error: unknown) => ({ refused: federationFailureReason(error) }),
    );

describe('XML signature wrapping', () => {
  it('starts from a response the gateway accepts, or these would prove nothing', async () => {
    const { fixture, xml } = genuine();
    await expect(refusal(fixture, xml)).resolves.toEqual({
      signedInAs: ATTACKER,
    });
  });

  it.each(WRAPS)('refuses %s', async (_name, wrap) => {
    const { fixture, xml } = genuine();
    const outcome = await refusal(fixture, wrap(xml));
    expect(outcome).toHaveProperty('refused');
    expect(outcome).not.toHaveProperty('signedInAs');
    expect((outcome as { refused: string }).refused).toMatch(/^saml_/u);
  });

  it.each([
    [
      'inside an attribute value',
      (nested: string) =>
        `<saml:Attribute Name="note"><saml:AttributeValue>${nested}</saml:AttributeValue></saml:Attribute>`,
    ],
    [
      'as an attribute of its own',
      (nested: string) =>
        `<saml:Attribute Name="note">${nested}</saml:Attribute>`,
    ],
    ['directly in the statement', (nested: string) => nested],
  ])(
    'names a correctly signed response with a second assertion nested %s',
    async (_where, place) => {
      const fixture = samlFixture(material);
      const nested = `<saml:Assertion ID="_nested" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${fixture.provider.issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">victim-person</saml:NameID></saml:Subject></saml:Assertion>`;
      const xml = Buffer.from(
        fixture.response({ additionalAttributes: place(nested) }),
        'base64',
      ).toString();
      await expect(refusal(fixture, xml)).resolves.toEqual({
        refused: 'saml_assertion_count',
      });
    },
  );

  it('names a nested assertion under another prefix, which a name match would miss', async () => {
    const fixture = samlFixture(material);
    const nested = `<x:Assertion xmlns:x="urn:oasis:names:tc:SAML:2.0:assertion" ID="_nested" Version="2.0"/>`;
    const xml = Buffer.from(
      fixture.response({
        additionalAttributes: `<saml:Attribute Name="note"><saml:AttributeValue>${nested}</saml:AttributeValue></saml:Attribute>`,
      }),
      'base64',
    ).toString();
    await expect(refusal(fixture, xml)).resolves.toEqual({
      refused: 'saml_assertion_count',
    });
  });

  // Canonicalization drops comments, so the signature still holds after this
  // edit. A parser that stopped at the comment would read the victim's address.
  it('reads the whole signed text when a comment splits it, never the part before', async () => {
    const fixture = samlFixture(material);
    const signedEmail = `${VICTIM}.attacker.test`,
      signedSubject = 'victim-person-attacker';
    const xml = Buffer.from(
      fixture.response({ email: signedEmail, subject: signedSubject }),
      'base64',
    )
      .toString()
      .replace(signedEmail, `${VICTIM}<!---->.attacker.test`)
      .replace(signedSubject, 'victim-person<!---->-attacker');

    await expect(
      gateway.verify(
        fixture.provider,
        fixture.proof,
        Buffer.from(xml).toString('base64'),
      ),
    ).resolves.toMatchObject({ email: signedEmail, subject: signedSubject });
  });
});
