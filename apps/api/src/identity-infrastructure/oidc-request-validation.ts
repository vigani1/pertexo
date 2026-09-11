import {
  IdentityError,
  type OidcAuthorizationRequest,
} from '../identity/index.js';

const MAXIMUM_OIDC_URL_LENGTH = 2_048;
export const MAXIMUM_AUTHORIZATION_URL_LENGTH = 8_192;
const MINIMUM_STATE_OR_NONCE_LENGTH = 16;
const MAXIMUM_STATE_OR_NONCE_LENGTH = 512;
const MINIMUM_PKCE_CHALLENGE_LENGTH = 32;
const MINIMUM_PKCE_VERIFIER_LENGTH = 43;
const MAXIMUM_PKCE_CHALLENGE_INPUT_LENGTH = 512;
const MAXIMUM_PKCE_VERIFIER_LENGTH = 128;
const MAXIMUM_AUTHORIZATION_SCOPES = 16;
const MAXIMUM_AUTHORIZATION_CODE_LENGTH = 4_096;

export function invalidAuthorizationRequest(): never {
  throw new IdentityError('identity.invalid_input');
}

export function assertAuthorizationRequest(
  request: OidcAuthorizationRequest,
  configuration: Readonly<{ clientId: string; redirectUri: string }>,
): void {
  if (
    request.state.length < MINIMUM_STATE_OR_NONCE_LENGTH ||
    request.state.length > MAXIMUM_STATE_OR_NONCE_LENGTH
  )
    invalidAuthorizationRequest();
  if (
    request.nonce.length < MINIMUM_STATE_OR_NONCE_LENGTH ||
    request.nonce.length > MAXIMUM_STATE_OR_NONCE_LENGTH
  )
    invalidAuthorizationRequest();
  if (
    request.codeChallenge.length < MINIMUM_PKCE_CHALLENGE_LENGTH ||
    request.codeChallenge.length > MAXIMUM_PKCE_CHALLENGE_INPUT_LENGTH
  )
    invalidAuthorizationRequest();
  if (request.redirectUri.length > MAXIMUM_OIDC_URL_LENGTH)
    invalidAuthorizationRequest();
  if (
    request.redirectUri !== configuration.redirectUri ||
    request.clientId !== configuration.clientId
  )
    invalidAuthorizationRequest();
  if (
    !/^[A-Za-z0-9_-]{16,512}$/u.test(request.state) ||
    !/^[A-Za-z0-9_-]{16,512}$/u.test(request.nonce) ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(request.codeChallenge)
  )
    invalidAuthorizationRequest();
  if (
    request.scopes.length < 1 ||
    request.scopes.length > MAXIMUM_AUTHORIZATION_SCOPES
  )
    invalidAuthorizationRequest();
  if (request.scopes.some((scope) => !/^[A-Za-z0-9._:-]{1,64}$/u.test(scope)))
    invalidAuthorizationRequest();
}

export function assertTokenExchangeInput(
  input: Readonly<{
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }>,
  configuredRedirectUri: string,
): void {
  if (
    input.code.length < 1 ||
    input.code.length > MAXIMUM_AUTHORIZATION_CODE_LENGTH
  )
    throw new IdentityError('identity.provider_rejected');
  if (
    input.codeVerifier.length < MINIMUM_PKCE_VERIFIER_LENGTH ||
    input.codeVerifier.length > MAXIMUM_PKCE_VERIFIER_LENGTH ||
    !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.codeVerifier)
  )
    throw new IdentityError('identity.provider_rejected');
  if (
    input.redirectUri.length > MAXIMUM_OIDC_URL_LENGTH ||
    input.redirectUri !== configuredRedirectUri
  )
    throw new IdentityError('identity.provider_rejected');
}
