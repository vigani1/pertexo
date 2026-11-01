import { X509Certificate } from 'node:crypto';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { SAML_LIMITS, type SamlConfiguration } from '@pertexo/contracts';
import { invalidSaml } from './xml.js';

export type SamlProviderMaterial = Readonly<{
  id: string;
  issuer: string;
  configuration: SamlConfiguration;
}>;
export type SamlProof = Readonly<{
  state: string;
  requestId: string;
  redirectUri: string;
  entityId: string;
  createdAt: Date;
}>;

export function samlTransportAvailable(
  publicOrigin: string,
  { secureCookies }: Readonly<{ secureCookies: boolean }>,
): boolean {
  return secureCookies && new URL(publicOrigin).protocol === 'https:';
}

export function validateSamlCertificates(
  configuration: SamlConfiguration,
): string[] {
  const certificates = configuration.certificates
    .map((value) => {
      const certificate = new X509Certificate(value),
        key = certificate.publicKey;
      if (
        key.asymmetricKeyType !== 'rsa' ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        return invalidSaml('saml_certificate');
      return certificate;
    })
    .filter(
      (certificate) =>
        Date.parse(certificate.validFrom) <= Date.now() &&
        Date.parse(certificate.validTo) > Date.now(),
    );
  if (certificates.length === 0) return invalidSaml('saml_certificate');
  return certificates.map((certificate) => certificate.toString());
}
export function configureSaml(
  provider: SamlProviderMaterial,
  proof: SamlProof,
): SAML {
  const registeredAt = proof.createdAt.toISOString();
  // This SDK seam checks correlation only. The durable journey is consumed once
  // with the identity transaction, including callbacks verified on other APIs.
  const lookup = (id: string | null) =>
    Promise.resolve(id === proof.requestId ? registeredAt : null);
  return new SAML({
    issuer: proof.entityId,
    callbackUrl: proof.redirectUri,
    entryPoint: provider.configuration.signInUrl,
    idpIssuer: provider.issuer,
    idpCert: validateSamlCertificates(provider.configuration),
    audience: proof.entityId,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    validateInResponseTo: ValidateInResponseTo.always,
    acceptedClockSkewMs: SAML_LIMITS.clockSkewMillis,
    maxAssertionAgeMs: SAML_LIMITS.assertionAgeMillis,
    requestIdExpirationPeriodMs: SAML_LIMITS.assertionAgeMillis,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    disableRequestedAuthnContext: true,
    generateUniqueId: () => proof.requestId,
    cacheProvider: {
      saveAsync: (id, value) =>
        Promise.resolve(
          id === proof.requestId
            ? { value, createdAt: proof.createdAt.getTime() }
            : null,
        ),
      getAsync: lookup,
      removeAsync: lookup,
    },
  });
}
