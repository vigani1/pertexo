import { SAML_LIMITS, samlServiceProviderUrls } from '@pertexo/contracts';
import { inflateRawSync } from 'node:zlib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createSamlProofGateway,
  samlServiceProviderMetadata,
} from '../../../../src/authentication/federation/protocol/saml/gateway.js';
import { validateSamlCertificates } from '../../../../src/authentication/federation/protocol/saml/configuration.js';
import {
  parseXml,
  root,
  SAML_PROTOCOL,
} from '../../../../src/authentication/federation/protocol/saml/xml.js';
import {
  signingMaterial,
  samlFixture,
  type SigningMaterial,
  type ResponseOptions,
} from './fixture.js';

let material: SigningMaterial;
beforeAll(() => {
  material = signingMaterial();
});
const gateway = createSamlProofGateway();
describe('SAML proof gateway with actual signed protocol responses', () => {
  it('correlates a Redirect request and consumes only the verified signed identity', async () => {
    const fixture = samlFixture(material);
    const url = new URL(
      await gateway.authorize(fixture.provider, fixture.proof),
    );
    expect(url.origin + url.pathname).toBe(
      fixture.provider.configuration.signInUrl,
    );
    expect(url.searchParams.get('RelayState')).toBe(fixture.proof.state);
    const request = root(
      parseXml(
        inflateRawSync(
          Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64'),
          { maxOutputLength: 16384 },
        ).toString(),
      ),
      SAML_PROTOCOL,
      'AuthnRequest',
    );
    expect(request.getAttribute('ID')).toBe(fixture.proof.requestId);
    expect(request.getAttribute('AssertionConsumerServiceURL')).toBe(
      fixture.proof.redirectUri,
    );
    await expect(
      gateway.verify(fixture.provider, fixture.proof, fixture.response()),
    ).resolves.toEqual({
      subject: 'immutable-person',
      email: 'person@example.test',
      displayName: 'Example Person',
    });
  });
  it('verifies an exactly maximum-size signed assertion without retaining its unused claims', async () => {
    const fixture = samlFixture(material);
    const attribute = (value: string) =>
      `<saml:Attribute Name="unused"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`;
    const overhead =
      Buffer.from(
        fixture.response({ additionalAttributes: attribute('x') }),
        'base64',
      ).length - 1;
    const response = fixture.response({
      additionalAttributes: attribute(
        'x'.repeat(SAML_LIMITS.xmlBytes - overhead),
      ),
    });
    expect(Buffer.from(response, 'base64')).toHaveLength(SAML_LIMITS.xmlBytes);
    const started = performance.now();
    await expect(
      gateway.verify(fixture.provider, fixture.proof, response),
    ).resolves.toEqual({
      subject: 'immutable-person',
      email: 'person@example.test',
      displayName: 'Example Person',
    });
    console.info(
      `SAML exact 256 KiB: ${String(Math.round(performance.now() - started))} ms; only normalized identity leaves the gateway`,
    );
  });
  it.each(['depth', 'elements', 'nodes', 'attributes'] as const)(
    'bounds signed XML %s before recursive SDK traversal',
    async (mode) => {
      const fixture = samlFixture(material);
      const value =
        mode === 'depth'
          ? '<item>'.repeat(40) + 'value' + '</item>'.repeat(40)
          : mode === 'elements'
            ? '<item/>'.repeat(SAML_LIMITS.elements)
            : mode === 'nodes'
              ? '<!--x-->'.repeat(SAML_LIMITS.nodes)
              : `<item ${Array.from({ length: SAML_LIMITS.attributes + 1 }, (_, index) => `a${String(index)}="x"`).join(' ')}/>`;
      const response = fixture.response({
        additionalAttributes: `<saml:Attribute Name="unused"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`,
      });
      await expect(
        gateway.verify(fixture.provider, fixture.proof, response),
      ).rejects.toThrow();
    },
  );
  it('accepts a fresh assertion from an older IdP login session', async () => {
    const fixture = samlFixture(material);
    await expect(
      gateway.verify(
        fixture.provider,
        fixture.proof,
        fixture.response({
          authnInstant: new Date(Date.now() - 86400000).toISOString(),
        }),
      ),
    ).resolves.toHaveProperty('subject', 'immutable-person');
  });
  it.each<[string, ResponseOptions]>([
    ['wrong response issuer', { responseIssuer: 'urn:wrong:idp' }],
    ['wrong assertion issuer', { assertionIssuer: 'urn:wrong:idp' }],
    [
      'wrong destination',
      { destination: 'https://wrong.example.test/callback' },
    ],
    ['wrong recipient', { recipient: 'https://wrong.example.test/callback' }],
    ['wrong audience', { audience: 'https://wrong.example.test/sp' }],
    ['unsolicited response', { requestId: '_not_requested' }],
    ['wrong subject correlation', { subjectRequestId: '_not_requested' }],
    ['unsigned response', { signResponse: false }],
    ['unsigned assertion', { signAssertion: false }],
    ['obsolete SHA-1 signatures', { sha1: true }],
    ['missing bearer confirmation', { omitConfirmation: true }],
    ['missing conditions', { omitConditions: true }],
    ['missing expiry', { omitExpiry: true }],
    [
      'transient identity',
      { nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient' },
    ],
    [
      'non-success status',
      { status: 'urn:oasis:names:tc:SAML:2.0:status:Responder' },
    ],
    ['non-email claim', { email: 'not an email' }],
    ['empty subject', { subject: '' }],
    [
      'ambiguous email claim',
      {
        additionalAttributes:
          '<saml:Attribute Name="email"><saml:AttributeValue>other@example.test</saml:AttributeValue></saml:Attribute>',
      },
    ],
  ])(
    'refuses %s even when the other signatures are valid',
    async (_name, options) => {
      const fixture = samlFixture(material);
      await expect(
        gateway.verify(
          fixture.provider,
          fixture.proof,
          fixture.response(options),
        ),
      ).rejects.toThrow();
    },
  );
  it.each([
    'expired',
    'old assertion',
    'future assertion',
    'future conditions',
  ] as const)('refuses %s timestamps', async (mode) => {
    const fixture = samlFixture(material);
    const options: ResponseOptions =
      mode === 'expired'
        ? { expiresAt: new Date(Date.now() - 180000).toISOString() }
        : mode === 'old assertion'
          ? { issuedAt: new Date(Date.now() - 480000).toISOString() }
          : mode === 'future assertion'
            ? { issuedAt: new Date(Date.now() + 180000).toISOString() }
            : { notBefore: new Date(Date.now() + 180000).toISOString() };
    await expect(
      gateway.verify(
        fixture.provider,
        fixture.proof,
        fixture.response(options),
      ),
    ).rejects.toThrow();
  });
  it('rejects an altered signed assertion and a response signed with another certificate', async () => {
    const fixture = samlFixture(material);
    const altered = Buffer.from(
      Buffer.from(fixture.response(), 'base64')
        .toString()
        .replace('immutable-person', 'impostor-person'),
    ).toString('base64');
    await expect(
      gateway.verify(fixture.provider, fixture.proof, altered),
    ).rejects.toThrow();
    const other = samlFixture(signingMaterial());
    await expect(
      gateway.verify(fixture.provider, fixture.proof, other.response()),
    ).rejects.toThrow();
  });
  it.each([
    'malformed XML',
    'DTD',
    'duplicate ID',
    'too large',
    'invalid base64',
    'invalid UTF-8',
  ] as const)('rejects %s before identity conversion', async (mode) => {
    const fixture = samlFixture(material);
    let xml = Buffer.from(fixture.response(), 'base64').toString();
    if (mode === 'malformed XML') xml = xml.replace('</samlp:Response>', '');
    if (mode === 'DTD')
      xml = '<!DOCTYPE samlp:Response [<!ENTITY a "value">]>' + xml;
    if (mode === 'duplicate ID')
      xml = xml.replace('ID="_assertion"', 'ID="_response"');
    if (mode === 'too large') xml = 'a'.repeat(262145);
    const encoded =
      mode === 'invalid base64'
        ? '!!!='
        : mode === 'invalid UTF-8'
          ? Buffer.from([0xc0, 0xaf]).toString('base64')
          : Buffer.from(xml).toString('base64');
    await expect(
      gateway.verify(fixture.provider, fixture.proof, encoded),
    ).rejects.toThrow();
  });
  it('accepts overlapping valid pinned certificates and rejects an expired trust set', async () => {
    const fixture = samlFixture(material),
      other = samlFixture(signingMaterial());
    await expect(
      gateway.verify(
        {
          ...fixture.provider,
          configuration: {
            ...fixture.provider.configuration,
            certificates: [
              material.certificate,
              other.provider.configuration.certificates[0] ?? '',
            ],
          },
        },
        fixture.proof,
        other.response(),
      ),
    ).resolves.toHaveProperty('subject', 'immutable-person');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 2 * 86400000);
      expect(() =>
        validateSamlCertificates(fixture.provider.configuration),
      ).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
  it('generates stable organization metadata without IdP or SP keys', () => {
    const fixture = samlFixture(material),
      origin = 'https://app.example.test';
    const urls = samlServiceProviderUrls(origin, fixture.provider.id);
    const metadata = samlServiceProviderMetadata(
      fixture.provider.id,
      origin,
    ).xml;
    expect(metadata).toContain(urls.entityId);
    expect(metadata).toContain(urls.redirectUri);
    expect(metadata).toContain('WantAssertionsSigned="true"');
    expect(metadata).toContain('AuthnRequestsSigned="false"');
    expect(() =>
      samlServiceProviderUrls('http://app.example.test', fixture.provider.id),
    ).toThrow();
  });
  it('refuses malformed or weak trust anchors', () => {
    const fixture = samlFixture(material),
      weak = signingMaterial(1024);
    expect(() =>
      validateSamlCertificates({
        ...fixture.provider.configuration,
        certificates: ['not a certificate'],
      }),
    ).toThrow();
    expect(() =>
      validateSamlCertificates({
        ...fixture.provider.configuration,
        certificates: [weak.certificate],
      }),
    ).toThrow();
  });
});
