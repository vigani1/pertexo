import type { OrganizationIdentity } from '../protocol/identity.js';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { OrganizationSignInCommands } from '@pertexo/core/identity';
import {
  federationProtocolSchema,
  samlServiceProviderUrls,
  type FederationProtocol,
  federationDiscoveryQuerySchema,
} from '@pertexo/contracts';
import type { OidcProofGateway } from '../protocol/oidc.js';
import type { SamlProofGateway } from '../protocol/saml/gateway.js';
import { samlTransportAvailable } from '../protocol/saml/configuration.js';
import {
  readOrganizationCallback,
  type OrganizationCallback,
} from './callback.js';
import {
  newJourneyToken,
  journeyDigest,
  journeyBindingCookie,
  readCookie,
  isJourneyToken,
  deriveJourneySecret,
  landWithReplacementSession,
} from '../../journeys/browser-proof.js';
import { type BrowserSession, prepareOrganizationStart } from './start.js';
import { failure } from './reply.js';

const callbackPath = '/v1/auth/federation/oidc/callback';

export class OrganizationSignIn {
  private readonly commands: OrganizationSignInCommands;
  private readonly cookieName: string;
  constructor(
    private readonly input: Readonly<{
      pool: Pool;
      baseUrl: string;
      secret: string;
      secureCookies: boolean;
      sessionTtlSeconds: number;
      gateway?: OidcProofGateway;
      samlGateway?: SamlProofGateway;
      authenticate(request: Request): Promise<BrowserSession | undefined>;
      deliver(token: string): Promise<readonly string[]>;
    }>,
  ) {
    this.commands = new OrganizationSignInCommands(input);
    this.cookieName = input.secureCookies
      ? '__Host-pertexo_organization_signin'
      : 'pertexo_organization_signin';
  }
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/auth/federation/discover') {
      const parsed = federationDiscoveryQuerySchema.safeParse(
        Object.fromEntries(url.searchParams),
      );
      if (
        request.method !== 'GET' ||
        !parsed.success ||
        [...url.searchParams.keys()].length !== 1
      )
        return failure(400);
      if (
        !federationProtocolSchema.options.some((protocol) =>
          this.available(protocol),
        )
      )
        return Response.json(
          { required: false, providers: [] },
          { headers: { 'cache-control': 'no-store' } },
        );
      const discovery = await this.commands.discover(parsed.data.domain);
      return Response.json(
        {
          ...discovery,
          providers: discovery.providers.filter((provider) =>
            this.available(provider.kind),
          ),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    for (const protocol of federationProtocolSchema.options) {
      const prefix = `/v1/auth/federation/${protocol}`;
      if (url.pathname === `${prefix}/start`)
        return request.method === 'POST'
          ? this.start(request, { testing: false, protocol: protocol })
          : failure(404);
      if (url.pathname === `${prefix}/test`)
        return request.method === 'POST'
          ? this.start(request, { testing: true, protocol: protocol })
          : failure(404);
      if (url.pathname === `${prefix}/callback`)
        return request.method === (protocol === 'oidc' ? 'GET' : 'POST')
          ? this.callback(request, protocol)
          : failure(404);
    }
    return undefined;
  }
  private available(protocol: FederationProtocol) {
    return protocol === 'oidc'
      ? this.input.gateway !== undefined
      : this.input.samlGateway !== undefined &&
          samlTransportAvailable(this.input.baseUrl, {
            secureCookies: this.input.secureCookies,
          });
  }
  private bindingCookie(protocol: FederationProtocol) {
    return protocol === 'oidc'
      ? this.cookieName
      : '__Host-pertexo_organization_saml';
  }
  private async start(
    request: Request,
    {
      testing,
      protocol,
    }: Readonly<{ testing: boolean; protocol: FederationProtocol }>,
  ): Promise<Response> {
    if (!this.available(protocol)) return failure(503);
    const raw: unknown = await request.json().catch(() => null);
    try {
      const prepared = await prepareOrganizationStart(request, raw, {
        testing,
        commands: this.commands,
        authenticate: (request) => this.input.authenticate(request),
      });
      if (prepared instanceof Response) return prepared;
      const { material, owner, returnPath } = prepared;
      if (material?.provider.kind !== protocol) return failure(404);
      const id = randomUUID(),
        state = newJourneyToken(),
        browser = newJourneyToken();
      const authorizationUrl =
        material.provider.kind === 'oidc'
          ? await this.input.gateway?.authorize(
              material.provider,
              this.proof(id, material.provider.id, state, browser),
            )
          : await this.input.samlGateway?.authorize(
              material.provider,
              this.samlProof(id, material.provider, {
                state: state,
                browser: browser,
                createdAt: new Date(),
              }),
            );
      if (authorizationUrl === undefined) return failure(503);
      await this.commands.start({
        id,
        providerId: material.provider.id,
        providerRevision: material.provider.revision,
        domainId: material.domainId,
        purpose: testing ? 'test' : 'sign_in',
        ...(owner === undefined
          ? {}
          : { ownerUserId: owner.userId, ownerSessionId: owner.sessionId }),
        stateDigest: journeyDigest(state),
        browserDigest: journeyDigest(browser),
        returnPath,
      });
      return Response.json(
        { authorizationUrl },
        {
          headers: {
            'cache-control': 'no-store',
            'set-cookie': journeyBindingCookie({
              name: this.bindingCookie(protocol),
              value: browser,
              path: '/',
              secure: this.input.secureCookies,
              sameSite: protocol === 'saml' ? 'none' : 'lax',
            }),
          },
        },
      );
    } catch {
      return failure(503);
    }
  }
  private async callback(
    request: Request,
    protocol: FederationProtocol,
  ): Promise<Response> {
    const url = new URL(request.url),
      callback = await readOrganizationCallback(request, protocol),
      browser = readCookie(request.headers, this.bindingCookie(protocol));
    const unavailableCallback =
      !this.available(protocol) ||
      callback === undefined ||
      browser === undefined ||
      !isJourneyToken(browser);
    if (unavailableCallback) return this.failed();
    const state = callback.state;
    let destination: string | undefined;
    let testing = false;
    try {
      const attempt = await this.commands.find(
        journeyDigest(state),
        journeyDigest(browser),
      );
      if (attempt?.provider.kind !== protocol) return this.failed();
      testing = attempt.purpose === 'test';
      destination = attempt.returnPath;
      let ownerSessionId: string | undefined;
      if (testing && protocol === 'oidc') {
        const current = await this.input.authenticate(request);
        if (
          current?.userId !== attempt.ownerUserId ||
          current.sessionId !== attempt.ownerSessionId
        )
          return this.failed(destination, { testing: true });
        ownerSessionId = current.sessionId;
      }
      if (testing && protocol === 'saml')
        ownerSessionId = attempt.ownerSessionId ?? undefined;
      const identity = await this.verifyIdentity(attempt, callback, {
        state,
        browser,
        url,
      });
      if (identity === undefined)
        return this.failed(destination, { testing: testing });
      const result = await this.commands.complete({
        attemptId: attempt.id,
        stateDigest: journeyDigest(state),
        browserDigest: journeyDigest(browser),
        identity,
        ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
      });
      if (result.kind === 'failed')
        return this.failed(destination, { testing: testing });
      if (result.kind === 'tested')
        return this.land(result.returnPath, 'passed');
      return await landWithReplacementSession(
        this.input.deliver,
        result.token,
        () => this.land(result.returnPath),
        () => this.failed(destination),
      );
    } catch {
      return this.failed(destination, { testing: testing });
    }
  }
  private async verifyIdentity(
    attempt: NonNullable<
      Awaited<ReturnType<OrganizationSignInCommands['find']>>
    >,
    callback: OrganizationCallback,
    {
      state,
      browser,
      url,
    }: Readonly<{ state: string; browser: string; url: URL }>,
  ): Promise<OrganizationIdentity | undefined> {
    let identity: OrganizationIdentity | undefined;
    if (attempt.provider.kind === 'oidc') {
      identity = await this.input.gateway?.verify(
        attempt.provider,
        this.proof(attempt.id, attempt.provider.id, state, browser),
        url,
      );
    } else if (callback.samlResponse !== undefined) {
      identity = await this.input.samlGateway?.verify(
        attempt.provider,
        this.samlProof(attempt.id, attempt.provider, {
          state: state,
          browser: browser,
          createdAt: attempt.createdAt,
        }),
        callback.samlResponse,
      );
    }

    return identity;
  }

  private proof(
    id: string,
    providerId: string,
    state: string,
    browser: string,
  ) {
    const purpose = `organization-sign-in:${id}:${providerId}:${browser}`;
    return {
      state,
      nonce: deriveJourneySecret(this.input.secret, purpose + ':nonce'),
      codeVerifier: deriveJourneySecret(this.input.secret, purpose + ':pkce'),
      redirectUri: new URL(callbackPath, this.input.baseUrl).toString(),
    };
  }
  private samlProof(
    id: string,
    provider: Readonly<{ id: string; organizationId: string }>,
    {
      state,
      browser,
      createdAt,
    }: Readonly<{ state: string; browser: string; createdAt: Date }>,
  ) {
    return {
      ...samlServiceProviderUrls(this.input.baseUrl, provider.organizationId),
      state,
      createdAt,
      requestId:
        '_' +
        deriveJourneySecret(
          this.input.secret,
          `organization-saml:${id}:${provider.id}:${state}:${browser}`,
        ),
    };
  }
  private land(path: string, test?: 'passed' | 'failed'): Response {
    const destination = new URL(path, this.input.baseUrl);
    if (test !== undefined) destination.searchParams.set('ssoTest', test);
    return new Response(null, {
      status: 302,
      headers: {
        location: destination.toString(),
        'cache-control': 'no-store',
      },
    });
  }
  private failed(
    path?: string,
    { testing = false }: Readonly<{ testing?: boolean | undefined }> = {},
  ): Response {
    if (testing && path !== undefined) return this.land(path, 'failed');
    const destination = new URL('/login', this.input.baseUrl);
    destination.searchParams.set('ssoError', 'true');
    if (path !== undefined && path !== '/workspaces')
      destination.searchParams.set('returnTo', path);
    return this.land(destination.pathname + destination.search);
  }
}
