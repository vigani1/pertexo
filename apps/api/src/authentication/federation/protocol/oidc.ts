import * as oidc from 'openid-client';
import type { OidcConfiguration } from '@pertexo/contracts';
import { FederationProofError, refuseAs } from './failure.js';
import { organizationIdentity, type OrganizationIdentity } from './identity.js';
import type {
  ApplicationSecretEnvelope,
  SecureHttpClient,
} from '@pertexo/integrations/server';

export type OidcProviderMaterial = Readonly<{
  id: string;
  controlWorkspaceId: string;
  issuer: string;
  configuration: OidcConfiguration;
  sealedSecret: unknown;
}>;
export type OidcProof = Readonly<{
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
}>;
export interface OidcProofGateway {
  authorize(provider: OidcProviderMaterial, proof: OidcProof): Promise<string>;
  verify(
    provider: OidcProviderMaterial,
    proof: OidcProof,
    callbackUrl: URL,
  ): Promise<OrganizationIdentity>;
}
export function federationSecretContext(
  workspaceId: string,
  providerId: string,
): string {
  return `organization-oidc:${workspaceId}:${providerId}`;
}
/** Only verified ID-token claims become identity; OAuth tokens never leave this gateway. */
export function createOidcProofGateway(
  input: Readonly<{
    http: Pick<SecureHttpClient, 'execute'>;
    envelope: ApplicationSecretEnvelope;
  }>,
): OidcProofGateway {
  const configure = async (
    provider: OidcProviderMaterial,
  ): Promise<oidc.Configuration> => {
    const secret = input.envelope.open(
      provider.sealedSecret,
      federationSecretContext(provider.controlWorkspaceId, provider.id),
    );
    const fetch = providerFetch(input.http, secret);
    const discovered = await oidc.discovery(
      new URL(provider.issuer),
      provider.configuration.clientId,
      undefined,
      undefined,
      { [oidc.customFetch]: fetch, timeout: 10 },
    );
    const metadata = discovered.serverMetadata();
    const methods = metadata.token_endpoint_auth_methods_supported ?? [
      'client_secret_basic',
    ];
    const authentication = clientAuthentication(methods, secret);
    if (authentication === undefined)
      throw new Error('OIDC client authentication method is unsupported');
    const algorithms = metadata.id_token_signing_alg_values_supported ?? [
      'RS256',
    ];
    const algorithm = [
      'RS256',
      'PS256',
      'ES256',
      'ES384',
      'ES512',
      'EdDSA',
    ].find((value) => algorithms.includes(value));
    if (algorithm === undefined)
      throw new Error('OIDC signing algorithm is unsupported');
    const config = new oidc.Configuration(
      metadata,
      provider.configuration.clientId,
      { id_token_signed_response_alg: algorithm },
      authentication,
    );
    config[oidc.customFetch] = fetch;
    config.timeout = 10;
    // The code-flow SDK otherwise relies on TLS for token authenticity.
    oidc.enableNonRepudiationChecks(config);
    return config;
  };
  return {
    authorize: async (provider, proof) => {
      const config = await configure(provider);
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: proof.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: proof.state,
        nonce: proof.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(
          proof.codeVerifier,
        ),
        code_challenge_method: 'S256',
      });
      if (
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== ''
      )
        throw new Error('OIDC authorization endpoint is unavailable');
      return url.toString();
    },
    verify: async (provider, proof, callbackUrl) => {
      const config = await refuseAs(
        'oidc_provider',
        'OIDC provider is unavailable',
        configure(provider),
      );
      const expected = new URL(proof.redirectUri);
      if (
        callbackUrl.origin !== expected.origin ||
        callbackUrl.pathname !== expected.pathname
      )
        throw new FederationProofError(
          'callback_invalid',
          'OIDC callback is invalid',
        );
      const tokens = await refuseAs(
        'oidc_token',
        'OIDC token exchange was refused',
        oidc.authorizationCodeGrant(config, callbackUrl, {
          expectedState: proof.state,
          expectedNonce: proof.nonce,
          pkceCodeVerifier: proof.codeVerifier,
          idTokenExpected: true,
        }),
      );
      const claims = tokens.claims();
      const unverifiedIdentityClaims =
        claims === undefined ||
        claims.email_verified === false ||
        (claims.email_verified !== undefined &&
          typeof claims.email_verified !== 'boolean');
      if (unverifiedIdentityClaims)
        throw new FederationProofError(
          'oidc_email_unverified',
          'OIDC identity is unverified',
        );
      return organizationIdentity(
        claims.sub,
        claims[provider.configuration.emailClaim],
        claims[provider.configuration.nameClaim],
      );
    },
  };
}

/** Every provider call goes through the guarded client, with the secret redacted. */
function providerFetch(
  http: Pick<SecureHttpClient, 'execute'>,
  secret: string,
): oidc.CustomFetch {
  return async (url, options) => {
    const request = new Request(url, {
      method: options.method,
      headers: options.headers,
      redirect: options.redirect,
      ...(options.body === undefined
        ? {}
        : {
            body:
              options.body instanceof Uint8Array
                ? new Uint8Array(options.body)
                : options.body,
          }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.duplex === undefined ? {} : { duplex: options.duplex }),
    });
    if (
      new URL(request.url).protocol !== 'https:' ||
      !['GET', 'POST'].includes(request.method)
    )
      throw new Error('OIDC endpoint transport is unavailable');
    const body =
      request.body === null
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    if (body !== undefined && body.byteLength > 65536)
      throw new Error('OIDC request is too large');
    const response = await http.execute({
      url: request.url,
      method: request.method === 'POST' ? 'POST' : 'GET',
      headers: Object.fromEntries(request.headers),
      ...(body === undefined ? {} : { body }),
      timeoutMillis: 10000,
      maxRedirects: 0,
      maxResponseBytes: 262144,
      sensitiveValues: [secret],
      signal: request.signal,
      beforeDispatch: () => Promise.resolve(),
    });
    return new Response(new Uint8Array(response.body), {
      status: response.status,
      headers: response.headers,
    });
  };
}

function clientAuthentication(
  methods: readonly string[],
  secret: string,
): ReturnType<typeof oidc.ClientSecretBasic> | undefined {
  if (methods.includes('client_secret_basic'))
    return oidc.ClientSecretBasic(secret);
  if (methods.includes('client_secret_post'))
    return oidc.ClientSecretPost(secret);
  return undefined;
}
