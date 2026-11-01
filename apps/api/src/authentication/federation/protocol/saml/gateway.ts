import { generateServiceProviderMetadata } from '@node-saml/node-saml';
import { samlServiceProviderUrls } from '@pertexo/contracts';
import type { OrganizationIdentity } from '../identity.js';
import {
  configureSaml,
  type SamlProviderMaterial,
  type SamlProof,
} from './configuration.js';
import { decodeResponse, invalidSaml } from './xml.js';
import {
  verifyResponseSemantics,
  verifiedAssertionIdentity,
} from './semantics.js';

export interface SamlProofGateway {
  authorize(provider: SamlProviderMaterial, proof: SamlProof): Promise<string>;
  verify(
    provider: SamlProviderMaterial,
    proof: SamlProof,
    response: string,
  ): Promise<OrganizationIdentity>;
}
export function createSamlProofGateway(): SamlProofGateway {
  return {
    authorize: (provider, proof) =>
      configureSaml(provider, proof).getAuthorizeUrlAsync(
        proof.state,
        undefined,
        {},
      ),
    verify: async (provider, proof, response) => {
      const xml = decodeResponse(response);
      const expected = {
        requestId: proof.requestId,
        issuer: provider.issuer,
        audience: proof.entityId,
        callbackUrl: proof.redirectUri,
      };
      const assertionId = verifyResponseSemantics(xml, expected);
      const verified = await configureSaml(provider, proof)
        .validatePostResponseAsync({ SAMLResponse: response })
        .catch(() => invalidSaml('saml_signature_invalid'));
      if (
        verified.loggedOut ||
        verified.profile === null ||
        typeof verified.profile.getAssertionXml !== 'function'
      )
        return invalidSaml();
      return verifiedAssertionIdentity(
        verified.profile.getAssertionXml(),
        expected,
        assertionId,
        provider.configuration,
      );
    },
  };
}
export function samlServiceProviderMetadata(
  organizationId: string,
  baseUrl: string,
) {
  const urls = samlServiceProviderUrls(baseUrl, organizationId);
  return {
    ...urls,
    xml: generateServiceProviderMetadata({
      issuer: urls.entityId,
      callbackUrl: urls.redirectUri,
      identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      wantAssertionsSigned: true,
    }),
  };
}
