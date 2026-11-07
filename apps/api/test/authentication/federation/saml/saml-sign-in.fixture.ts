import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignedXml } from 'xml-crypto';
import type {
  SamlProof,
  SamlProviderMaterial,
} from '../../../../src/authentication/federation/protocol/saml/configuration.js';

const base = 'urn:oasis:names:tc:SAML:2.0';
const assertionNamespace = `${base}:assertion`,
  protocolNamespace = `${base}:protocol`;
export function signingMaterial(bits = 2048, days = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-saml-'));
  try {
    const key = join(directory, 'key.pem'),
      certificate = join(directory, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        `rsa:${String(bits)}`,
        '-nodes',
        '-keyout',
        key,
        '-out',
        certificate,
        '-days',
        String(days),
        '-subj',
        '/CN=owned-saml.test',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    return {
      privateKey: readFileSync(key),
      certificate: readFileSync(certificate).toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
export type SigningMaterial = ReturnType<typeof signingMaterial>;
function escape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
export type ResponseOptions = Readonly<{
  responseIssuer?: string;
  assertionIssuer?: string;
  destination?: string;
  recipient?: string;
  audience?: string;
  requestId?: string;
  subjectRequestId?: string;
  issuedAt?: string;
  expiresAt?: string;
  notBefore?: string;
  authnInstant?: string;
  email?: string;
  subject?: string;
  nameIdFormat?: string;
  status?: string;
  signResponse?: boolean;
  signAssertion?: boolean;
  sha1?: boolean;
  omitConfirmation?: boolean;
  omitConditions?: boolean;
  omitExpiry?: boolean;
  duplicateAssertion?: boolean;
  additionalAttributes?: string;
}>;
function sign(
  xml: string,
  id: string,
  material: SigningMaterial,
  sha1: boolean,
) {
  const signer = new SignedXml({
    privateKey: material.privateKey,
    publicCert: material.certificate,
    signatureAlgorithm: sha1
      ? 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
      : 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  signer.addReference({
    xpath: `//*[@ID='${id}']`,
    digestAlgorithm: sha1
      ? 'http://www.w3.org/2000/09/xmldsig#sha1'
      : 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  });
  signer.computeSignature(xml, {
    location: {
      reference: `//*[@ID='${id}']/*[local-name()='Issuer']`,
      action: 'after',
    },
  });
  return signer.getSignedXml();
}
export function samlFixture(material: SigningMaterial) {
  const provider: SamlProviderMaterial = {
    id: '11111111-1111-4111-8111-111111111111',
    issuer: 'urn:owned:pertexo:idp',
    configuration: {
      signInUrl: 'https://idp.example.test/sso',
      certificates: [material.certificate],
      emailAttribute: 'email',
      nameAttribute: 'name',
      jitEnabled: false,
    },
  };
  const proof: SamlProof = {
    state: 's'.repeat(43),
    requestId: '_owned_request',
    createdAt: new Date(),
    entityId: 'https://app.example.test/saml/provider',
    redirectUri: 'https://app.example.test/v1/auth/federation/saml/callback',
  };
  return {
    provider,
    proof,
    response: (options: ResponseOptions = {}) =>
      signedResponse(material, provider, proof, options),
  };
}
export function signedResponse(
  material: SigningMaterial,
  provider: SamlProviderMaterial,
  proof: SamlProof,
  options: ResponseOptions = {},
) {
  const issuedAt = escape(options.issuedAt ?? new Date().toISOString());
  const expiresAt = escape(
    options.expiresAt ?? new Date(Date.now() + 240000).toISOString(),
  );
  const notBefore = escape(
    options.notBefore ?? new Date(Date.now() - 60000).toISOString(),
  );
  const expiry = options.omitExpiry ? '' : ` NotOnOrAfter="${expiresAt}"`;
  const confirmation = subjectConfirmation({ proof, options, expiry });
  const conditions = assertionConditions({ proof, options, notBefore, expiry });
  let assertion = unsignedAssertion({
    provider,
    options,
    issuedAt,
    confirmation,
    conditions,
  });
  if (options.signAssertion !== false)
    assertion = sign(assertion, '_assertion', material, options.sha1 ?? false);
  let response = unsignedResponse({
    provider,
    proof,
    options,
    issuedAt,
    assertion,
  });
  if (options.signResponse !== false)
    response = sign(response, '_response', material, options.sha1 ?? false);
  return Buffer.from(response).toString('base64');
}

function subjectConfirmation(
  input: Readonly<{
    proof: SamlProof;
    options: ResponseOptions;
    expiry: string;
  }>,
): string {
  const { proof, options, expiry } = input;
  return options.omitConfirmation
    ? ''
    : `<saml:SubjectConfirmation Method="${base}:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${escape(options.subjectRequestId ?? proof.requestId)}" Recipient="${escape(options.recipient ?? proof.redirectUri)}"${expiry}/></saml:SubjectConfirmation>`;
}

function assertionConditions(
  input: Readonly<{
    proof: SamlProof;
    options: ResponseOptions;
    notBefore: string;
    expiry: string;
  }>,
): string {
  const { proof, options, notBefore, expiry } = input;
  return options.omitConditions
    ? ''
    : `<saml:Conditions NotBefore="${notBefore}"${expiry}><saml:AudienceRestriction><saml:Audience>${escape(options.audience ?? proof.entityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`;
}

function unsignedAssertion(
  input: Readonly<{
    provider: SamlProviderMaterial;
    options: ResponseOptions;
    issuedAt: string;
    confirmation: string;
    conditions: string;
  }>,
): string {
  const { provider, options, issuedAt, confirmation, conditions } = input;
  return `<saml:Assertion xmlns:saml="${assertionNamespace}" ID="_assertion" Version="2.0" IssueInstant="${issuedAt}"><saml:Issuer>${escape(options.assertionIssuer ?? provider.issuer)}</saml:Issuer><saml:Subject><saml:NameID Format="${escape(options.nameIdFormat ?? `${base}:nameid-format:persistent`)}">${escape(options.subject ?? 'immutable-person')}</saml:NameID>${confirmation}</saml:Subject>${conditions}<saml:AuthnStatement AuthnInstant="${escape(options.authnInstant ?? new Date().toISOString())}"><saml:AuthnContext><saml:AuthnContextClassRef>${base}:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${escape(options.email ?? 'person@example.test')}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="name"><saml:AttributeValue>Example Person</saml:AttributeValue></saml:Attribute>${options.additionalAttributes ?? ''}</saml:AttributeStatement></saml:Assertion>`;
}

function unsignedResponse(
  input: Readonly<{
    provider: SamlProviderMaterial;
    proof: SamlProof;
    options: ResponseOptions;
    issuedAt: string;
    assertion: string;
  }>,
): string {
  const { provider, proof, options, issuedAt, assertion } = input;
  return `<samlp:Response xmlns:samlp="${protocolNamespace}" xmlns:saml="${assertionNamespace}" ID="_response" Version="2.0" IssueInstant="${issuedAt}" Destination="${escape(options.destination ?? proof.redirectUri)}" InResponseTo="${escape(options.requestId ?? proof.requestId)}"><saml:Issuer>${escape(options.responseIssuer ?? provider.issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${escape(options.status ?? `${base}:status:Success`)}"/></samlp:Status>${assertion}${options.duplicateAssertion ? assertion : ''}</samlp:Response>`;
}
