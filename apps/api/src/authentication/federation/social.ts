import { randomUUID } from 'node:crypto';
import {
  SocialSignInCommands,
  type SignUpMode,
} from '@pertexo/database/tenant-access';
import {
  authenticationProviderSchema,
  authenticationReturnPathSchema,
  socialSignInStartSchema,
} from '@pertexo/contracts';
import type { Pool } from 'pg';
import type {
  SocialProviderGateway,
  SocialProviderName,
} from '../providers/contract.js';
import {
  deriveJourneySecret,
  isJourneyToken,
  journeyDigest,
  journeyBindingCookie,
  landWithReplacementSession,
  newJourneyToken,
  readCookie,
} from '../journeys/browser-proof.js';

const CALLBACK_PATH = '/v1/auth/federation/social/callback/';

/** Provider verification finishes before the identity transaction is acquired. */
export class SocialSignIn {
  private readonly commands: SocialSignInCommands;
  private readonly cookieName: string;
  public constructor(
    private readonly input: Readonly<{
      pool: Pool;
      signUpMode: SignUpMode;
      secret: string;
      baseUrl: string;
      secureCookies: boolean;
      sessionTtlSeconds: number;
      providers: SocialProviderGateway;
      deliver(token: string): Promise<readonly string[]>;
    }>,
  ) {
    this.commands = new SocialSignInCommands(input);
    this.cookieName = input.secureCookies
      ? '__Host-pertexo_signin'
      : 'pertexo_signin';
  }

  public async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/auth/sign-in/social')
      return request.method === 'POST' ? this.start(request) : failure(404);
    if (!url.pathname.startsWith(CALLBACK_PATH)) return undefined;
    const provider = authenticationProviderSchema.safeParse(
      url.pathname.slice(CALLBACK_PATH.length),
    );
    if (request.method !== 'GET' || !provider.success) return failure(404);
    return this.callback(request, provider.data);
  }

  private async start(request: Request): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const parsed = socialSignInStartSchema.safeParse(raw);
    if (!parsed.success) return failure(400);
    const { provider } = parsed.data;
    if (!this.input.providers.available.includes(provider)) return failure(404);
    const returnPath = authenticationReturnPathSchema.safeParse(
      parsed.data.callbackURL,
    );
    const id = randomUUID();
    const state = newJourneyToken();
    const browser = newJourneyToken();
    try {
      const url = await this.input.providers.authorize({
        provider,
        state,
        redirectUri: this.redirectUri(provider),
        ...this.proofSecrets(id, provider, browser),
      });
      await this.commands.start({
        id,
        provider,
        stateDigest: journeyDigest(state),
        browserDigest: journeyDigest(browser),
        returnPath: returnPath.success ? returnPath.data : '/workspaces',
      });
      return Response.json(
        { url, redirect: true },
        {
          headers: {
            'cache-control': 'no-store',
            'set-cookie': journeyBindingCookie({
              name: this.cookieName,
              value: browser,
              path: '/',
              secure: this.input.secureCookies,
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
    provider: SocialProviderName,
  ): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const state = query.get('state');
    const browser = readCookie(request.headers, this.cookieName);
    const code = query.get('code');
    const invalidSocialCallback =
      state === null ||
      !isJourneyToken(state) ||
      browser === undefined ||
      !isJourneyToken(browser) ||
      code === null ||
      code.length === 0 ||
      code.length > 4096 ||
      query.has('error') ||
      ['state', 'code', 'iss'].some((name) => query.getAll(name).length > 1);
    if (invalidSocialCallback) return this.failed();
    let returnPath: string | undefined;
    try {
      const attempt = await this.commands.find(
        journeyDigest(state),
        journeyDigest(browser),
      );
      if (
        attempt?.provider !== provider ||
        !this.input.providers.available.includes(provider)
      )
        return this.failed();
      returnPath = attempt.returnPath;
      const issuer = query.get('iss');
      if (issuer !== null && issuer.length > 2048)
        return this.failed(returnPath);
      const identity = await this.input.providers.verify({
        provider,
        code,
        issuer,
        redirectUri: this.redirectUri(provider),
        ...this.proofSecrets(attempt.id, provider, browser),
      });
      if (identity === undefined) return this.failed(returnPath);
      const result = await this.commands.complete({
        attemptId: attempt.id,
        provider,
        stateDigest: journeyDigest(state),
        browserDigest: journeyDigest(browser),
        identity: {
          ...identity,
          displayName: identity.displayName ?? 'Pertexo member',
        },
      });
      if (result.kind !== 'signed_in') return this.failed(returnPath);
      return await landWithReplacementSession(
        this.input.deliver,
        result.token,
        () =>
          new Response(null, {
            status: 302,
            headers: {
              location: new URL(
                result.returnPath,
                this.input.baseUrl,
              ).toString(),
              'cache-control': 'no-store',
            },
          }),
        () => this.failed(returnPath),
      );
    } catch {
      return this.failed(returnPath);
    }
  }

  private redirectUri(provider: SocialProviderName): string {
    return new URL(
      `${CALLBACK_PATH}${provider}`,
      this.input.baseUrl,
    ).toString();
  }

  private proofSecrets(id: string, provider: string, browser: string) {
    const purpose = `social-sign-in:${id}:${provider}:${browser}`;
    return {
      codeVerifier: deriveJourneySecret(this.input.secret, `${purpose}:pkce`),
      nonce: deriveJourneySecret(this.input.secret, `${purpose}:nonce`),
    };
  }

  private failed(returnPath?: string): Response {
    const url = new URL('/login?socialError=true', this.input.baseUrl);
    if (returnPath !== undefined && returnPath !== '/workspaces')
      url.searchParams.set('returnTo', returnPath);
    return new Response(null, {
      status: 302,
      headers: { location: url.toString(), 'cache-control': 'no-store' },
    });
  }
}

function failure(status: number): Response {
  return Response.json(
    { code: 'SOCIAL_SIGN_IN_UNAVAILABLE' },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}
