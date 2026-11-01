import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { AccountLinkingCommands } from '@pertexo/core/identity';
import {
  accountSecurityLinkStartRequestSchema,
  authenticationProviderSchema,
} from '@pertexo/contracts';
import type {
  SocialProviderGateway,
  SocialProviderName,
} from '../providers/contract.js';

import {
  deriveJourneySecret,
  isJourneyToken,
  journeyBindingCookie,
  journeyDigest,
  landWithReplacementSession,
  newJourneyToken,
  readCookie,
} from '../journeys/browser-proof.js';

type BrowserSession = Readonly<{
  userId: string;
  sessionId: string;
  emailVerified: boolean;
}>;

const LINK_COOKIE = 'pertexo_link';
const LINK_PATH = '/v1/auth/account-security/methods/link';

/** Owns only the two-sided linking journey; Better Auth still verifies providers. */
export class AccountLinking {
  private readonly commands: AccountLinkingCommands;
  public constructor(
    private readonly input: Readonly<{
      pool: Pool;
      secret: string;
      baseUrl: string;
      secureCookies: boolean;
      sessionTtlSeconds: number;
      providers: SocialProviderGateway;
      authenticate(request: Request): Promise<BrowserSession | undefined>;
      verifyPassword(userId: string, password: string): Promise<boolean>;
      deliver(token: string): Promise<readonly string[]>;
    }>,
  ) {
    this.commands = new AccountLinkingCommands(input);
  }

  public async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${LINK_PATH}/`)) return undefined;
    if (url.pathname === `${LINK_PATH}/start` && request.method === 'POST')
      return this.start(request);
    const callbackPath = `${LINK_PATH}/callback/`;
    if (url.pathname.startsWith(callbackPath) && request.method === 'GET') {
      const provider = authenticationProviderSchema.safeParse(
        url.pathname.slice(callbackPath.length),
      );
      if (provider.success) return this.callback(request, provider.data);
    }
    return new Response(null, { status: 404 });
  }

  private async start(request: Request): Promise<Response> {
    if (!validCsrf(request.headers)) return problem(403);
    const session = await this.input.authenticate(request);
    if (session === undefined) return problem(401);
    if (!session.emailVerified) return problem(403);
    const body = accountSecurityLinkStartRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success) return problem(400);
    const { provider, existingMethod } = body.data;
    if (!this.input.providers.available.includes(provider)) return problem(404);
    const sourceProvider =
      existingMethod.kind === 'password'
        ? 'credential'
        : existingMethod.provider;
    if (sourceProvider === provider) return problem(400);
    if (
      sourceProvider !== 'credential' &&
      !this.input.providers.available.includes(sourceProvider)
    )
      return problem(404);
    if (existingMethod.kind === 'password') {
      if (
        !(await this.input.verifyPassword(
          session.userId,
          existingMethod.password,
        ))
      )
        return problem(403);
    } else {
      if (!(await this.commands.hasMethod(session.userId, sourceProvider)))
        return problem(403);
    }
    if (await this.commands.hasMethod(session.userId, provider))
      return problem(409);

    const attemptId = randomUUID();
    const binding = newJourneyToken();
    const state = newJourneyToken();
    const phase = sourceProvider === 'credential' ? 'target' : 'source';
    const activeProvider =
      phase === 'target' ? provider : (sourceProvider as SocialProviderName);
    const authorizationUrl = await this.authorizationUrl(
      attemptId,
      phase,
      activeProvider,
      state,
    ).catch(() => undefined);
    if (authorizationUrl === undefined) return problem(503);
    await this.commands.start({
      id: attemptId,
      userId: session.userId,
      sessionId: session.sessionId,
      browserDigest: journeyDigest(binding),
      sourceProvider,
      targetProvider: provider,
      phase,
      stateDigest: journeyDigest(state),
    });
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', this.bindingCookie(binding));
    return new Response(JSON.stringify({ authorizationUrl }), {
      status: 200,
      headers,
    });
  }

  private async callback(
    request: Request,
    provider: SocialProviderName,
  ): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const binding = readCookie(request.headers, LINK_COOKIE);
    const invalidCallbackProof =
      !isJourneyToken(state) ||
      code.length === 0 ||
      code.length > 4096 ||
      binding === undefined ||
      providerRejectedLinkCallback(url);
    if (invalidCallbackProof) return this.landing('failed');
    const session = await this.input.authenticate(request);
    if (session === undefined) return this.landing('sign-in');
    const attempt = await this.commands.find(journeyDigest(state));
    const journeyMismatch =
      attempt?.userId !== session.userId ||
      attempt.sessionId !== session.sessionId ||
      !journeyDigest(binding).equals(attempt.browserDigest) ||
      (attempt.phase === 'source'
        ? attempt.sourceProvider
        : attempt.targetProvider) !== provider;
    if (journeyMismatch) return this.landing('failed');
    const identity = await this.input.providers
      .verify({
        provider,
        code,
        codeVerifier: this.derived(attempt.id, attempt.phase, 'pkce'),
        nonce: this.derived(attempt.id, attempt.phase, 'nonce'),
        redirectUri: this.callbackUrl(provider),
        issuer: url.searchParams.get('iss'),
      })
      .catch(() => undefined);
    if (identity === undefined) return this.landing('failed');

    if (attempt.phase === 'source')
      return this.advanceToTarget(attempt, { state, binding, identity });
    const outcome = await this.commands.completeTarget(
      attempt,
      state,
      binding,
      identity,
    );
    if (outcome.kind === 'failed') return this.landing('failed');
    if (outcome.kind === 'already') return this.landing('returned');
    return landWithReplacementSession(
      (token) => this.input.deliver(token),
      outcome.token,
      () => this.landing('returned'),
      () => this.landing('sign-in'),
    );
  }

  private async advanceToTarget(
    attempt: Parameters<AccountLinkingCommands['updateSource']>[0],
    {
      state,
      binding,
      identity,
    }: Pick<
      Parameters<AccountLinkingCommands['updateSource']>[1],
      'state' | 'binding' | 'identity'
    >,
  ): Promise<Response> {
    const nextState = newJourneyToken();
    const nextUrl = await this.authorizationUrl(
      attempt.id,
      'target',
      attempt.targetProvider,
      nextState,
    ).catch(() => undefined);
    if (nextUrl === undefined) return this.landing('failed');
    const accepted = await this.commands.updateSource(attempt, {
      state,
      binding,
      identity,
      nextState,
    });
    return accepted ? Response.redirect(nextUrl, 302) : this.landing('failed');
  }

  private async authorizationUrl(
    attemptId: string,
    phase: 'source' | 'target',
    provider: SocialProviderName,
    state: string,
  ): Promise<string> {
    return this.input.providers.authorize({
      provider,
      state,
      codeVerifier: this.derived(attemptId, phase, 'pkce'),
      nonce: this.derived(attemptId, phase, 'nonce'),
      redirectUri: this.callbackUrl(provider),
    });
  }

  private derived(id: string, phase: string, purpose: string): string {
    return deriveJourneySecret(
      this.input.secret,
      `pertexo-link:${id}:${phase}:${purpose}`,
    );
  }

  private callbackUrl(provider: SocialProviderName): string {
    return new URL(
      `${LINK_PATH}/callback/${provider}`,
      this.input.baseUrl,
    ).toString();
  }

  private bindingCookie(binding: string): string {
    return journeyBindingCookie({
      name: LINK_COOKIE,
      value: binding,
      path: LINK_PATH,
      secure: this.input.secureCookies,
    });
  }

  private landing(outcome: 'returned' | 'failed' | 'sign-in'): Response {
    const url = new URL(LINK_LANDINGS[outcome], this.input.baseUrl);
    // A late callback must not erase a newer link journey's browser binding.
    // The five-minute HttpOnly cookie expires naturally and cannot replay a
    // consumed state.
    return new Response(null, {
      status: 302,
      headers: { location: url.toString() },
    });
  }
}

function validCsrf(headers: Headers): boolean {
  const token = headers.get('x-csrf-token');
  const cookie = readCookie(headers, 'pertexo_csrf');
  if (token === null || cookie === undefined || token.length < 32) return false;
  try {
    return token === decodeURIComponent(cookie);
  } catch {
    return false;
  }
}

function problem(status: number): Response {
  return Response.json({ code: 'LINK_ATTEMPT_UNAVAILABLE' }, { status });
}

const LINK_LANDINGS = {
  'sign-in': '/login?error=link_reauthenticate',
  returned: '/account/security?linked=true',
  failed: '/account/security?linkError=true',
} as const;

function providerRejectedLinkCallback(url: URL): boolean {
  const rejected =
    url.searchParams.has('error') ||
    ['state', 'code', 'iss'].some(
      (name) => url.searchParams.getAll(name).length > 1,
    ) ||
    (url.searchParams.get('iss')?.length ?? 0) > 2048;
  return rejected;
}
