import { SAML_LIMITS, type FederationProtocol } from '@pertexo/contracts';
import { isJourneyToken } from '../../journeys/browser-proof.js';
import { CALLBACK_LIMITS } from '../../journeys/callback-limits.js';

// A SAML callback posts exactly RelayState and SAMLResponse.
const SAML_CALLBACK_FIELDS = 2;
export type OrganizationCallback = Readonly<{
  state: string;
  samlResponse?: string;
}>;
/** Each protocol has one exact bounded front-channel transport. */
export async function readOrganizationCallback(
  request: Request,
  protocol: FederationProtocol,
): Promise<OrganizationCallback | undefined> {
  const url = new URL(request.url);
  if (protocol === 'oidc') return readOidcCallback(url);
  return readSamlCallback(request, url);
}

function readOidcCallback(url: URL): OrganizationCallback | undefined {
  const state = url.searchParams.get('state'),
    code = url.searchParams.get('code');
  const invalidOidcCallback =
    state === null ||
    !isJourneyToken(state) ||
    code === null ||
    code.length === 0 ||
    code.length > CALLBACK_LIMITS.codeCharacters ||
    url.searchParams.has('error') ||
    ['state', 'code', 'iss'].some(
      (name) => url.searchParams.getAll(name).length > 1,
    );
  if (invalidOidcCallback) return undefined;
  return { state };
}

async function readSamlCallback(
  request: Request,
  url: URL,
): Promise<OrganizationCallback | undefined> {
  if (
    url.search !== '' ||
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/x-www-form-urlencoded'
  )
    return undefined;
  const body = await request.text();
  if (Buffer.byteLength(body) > SAML_LIMITS.formBytes) return undefined;
  const fields = new URLSearchParams(body),
    state = fields.get('RelayState'),
    response = fields.get('SAMLResponse');
  const invalidSamlCallback =
    fields.size !== SAML_CALLBACK_FIELDS ||
    fields.getAll('RelayState').length !== 1 ||
    fields.getAll('SAMLResponse').length !== 1 ||
    state === null ||
    !isJourneyToken(state) ||
    response === null ||
    response.length === 0 ||
    response.length > SAML_LIMITS.encodedCharacters;
  if (invalidSamlCallback) return undefined;
  return { state, samlResponse: response };
}
