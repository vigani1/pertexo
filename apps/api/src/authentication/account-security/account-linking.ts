import { browserCsrfRefusal } from '../../identity/csrf.js';
import { HttpStatus } from '@nestjs/common';
import { recordAuthenticationFailure } from '../journeys/failures.js';
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
} from '../social-provider.types.js';

import {
  deriveJourneySecret,
  isJourneyToken,
  journeyBindingCookie,
  journeyDigest,
  landWithReplacementSession,
  newJourneyToken,
  readCookie,
} from '../journeys/browser-proof.js';
import { CALLBACK_LIMITS } from '../journeys/callback-limits.js';

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
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${LINK_PATH}/`)) return undefined;
      if (url.pathname === `${LINK_PATH}/start` && request.method === 'POST')
        return await this.start(request);
      const callbackPath = `${LINK_PATH}/callback/`;
      if (url.pathname.startsWith(callbackPath) && request.method === 'GET') {
        const provider = authenticationProviderSchema.safeParse(
          url.pathname.slice(callbackPath.length),
        );
        if (provider.success)
          return await this.callback(request, provider.data);
      }
      return new Response(null, { status: HttpStatus.NOT_FOUND });
    } catch {
      const callback = new URL(request.url).pathname.includes('/callback/');
      recordAuthenticationFailure(
        request.headers.get('x-request-id'),
        callback ? 'link_callback' : 'link_start',
        'internal_failure',
        'failed',
      );
      return callback
        ? this.landing('failed')
        : problem(HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  private async start(request: Request): Promise<Response> {
    const csrfRefusal = browserCsrfRefusal(request.headers);
    if (csrfRefusal !== undefined) return problem(csrfRefusal);
    const session = await this.input.authenticate(request);
    if (session === undefined) return problem(HttpStatus.UNAUTHORIZED);
    // Better Auth's own code, which the bridge names auth.email_not_verified.
    if (!session.emailVerified)
      return problem(HttpStatus.FORBIDDEN, 'EMAIL_NOT_VERIFIED');
    const body = accountSecurityLinkStartRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success) return problem(HttpStatus.BAD_REQUEST);
    const { provider, existingMethod } = body.data;
    if (!this.input.providers.available.includes(provider))
      return problem(HttpStatus.NOT_FOUND);
    const sourceProvider =
      existingMethod.kind === 'password'
        ? 'credential'
        : existingMethod.provider;
    if (sourceProvider === provider) return problem(HttpStatus.BAD_REQUEST);
    if (
      sourceProvider !== 'credential' &&
      !this.input.providers.available.includes(sourceProvider)
    )
      return problem(HttpStatus.NOT_FOUND);
    // Each refusal keeps its own code, so the dialog can say which proof
    // failed: a wrong password reads as Change password's does, and a
    // source method gone since the dialog opened as changed sign-in settings.
    if (existingMethod.kind === 'password') {
      if (
        !(await this.input.verifyPassword(
          session.userId,
          existingMethod.password,
        ))
      )
        return problem(HttpStatus.BAD_REQUEST, 'INVALID_PASSWORD');
    } else {
      if (!(await this.commands.hasMethod(session.userId, sourceProvider)))
        return problem(HttpStatus.CONFLICT, 'AUTHENTICATION_CHANGED');
    }
    if (await this.commands.hasMethod(session.userId, provider))
      return problem(HttpStatus.CONFLICT);

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
    ).catch(() => {
      recordAuthenticationFailure(
        request.headers.get('x-request-id'),
        'link_start',
        'provider_unavailable',
        'failed',
      );
      return undefined;
    });
    if (authorizationUrl === undefined)
      return problem(HttpStatus.SERVICE_UNAVAILABLE);
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
      status: HttpStatus.OK,
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
      code.length > CALLBACK_LIMITS.codeCharacters ||
      binding === undefined ||
      providerRejectedLinkCallback(url);
    if (invalidCallbackProof) return this.refused(request, 'callback_invalid');
    const session = await this.input.authenticate(request);
    if (session === undefined)
      return this.refused(request, 'attempt_unavailable', 'sign-in');
    const attempt = await this.commands.find(journeyDigest(state));
    const journeyMismatch =
      attempt?.userId !== session.userId ||
      attempt.sessionId !== session.sessionId ||
      !journeyDigest(binding).equals(attempt.browserDigest) ||
      (attempt.phase === 'source'
        ? attempt.sourceProvider
        : attempt.targetProvider) !== provider;
    if (journeyMismatch) return this.refused(request, 'attempt_unavailable');
    const identity = await this.input.providers
      .verify({
        provider,
        code,
        codeVerifier: this.derived(attempt.id, attempt.phase, 'pkce'),
        nonce: this.derived(attempt.id, attempt.phase, 'nonce'),
        redirectUri: this.callbackUrl(provider),
        issuer: url.searchParams.get('iss'),
      })
      .then(
        (identity) => {
          if (identity === undefined)
            recordAuthenticationFailure(
              request.headers.get('x-request-id'),
              'link_callback',
              'proof_refused',
              'refused',
            );
          return identity;
        },
        () => {
          recordAuthenticationFailure(
            request.headers.get('x-request-id'),
            'link_callback',
            'provider_unavailable',
            'failed',
          );
          return undefined;
        },
      );
    if (identity === undefined) return this.landing('failed');

    if (attempt.phase === 'source')
      return this.advanceToTarget(request, attempt, {
        state,
        binding,
        identity,
      });
    const outcome = await this.commands.completeTarget(
      attempt,
      state,
      binding,
      identity,
    );
    if (outcome.kind === 'failed')
      return this.refused(request, 'account_refused');
    if (outcome.kind === 'already') return this.landing('returned');
    return landWithReplacementSession(
      (token) => this.input.deliver(token),
      outcome.token,
      () => this.landing('returned'),
      () => {
        recordAuthenticationFailure(
          request.headers.get('x-request-id'),
          'link_callback',
          'session_delivery_failed',
          'failed',
        );
        return this.landing('sign-in');
      },
    );
  }

  private async advanceToTarget(
    request: Request,
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
    ).catch(() => {
      recordAuthenticationFailure(
        request.headers.get('x-request-id'),
        'link_callback',
        'provider_unavailable',
        'failed',
      );
      return undefined;
    });
    if (nextUrl === undefined) return this.landing('failed');
    const accepted = await this.commands.updateSource(attempt, {
      state,
      binding,
      identity,
      nextState,
    });
    return accepted
      ? Response.redirect(nextUrl, HttpStatus.FOUND)
      : this.refused(request, 'proof_refused');
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

  private refused(
    request: Request,
    reason:
      | 'callback_invalid'
      | 'attempt_unavailable'
      | 'account_refused'
      | 'proof_refused',
    outcome: 'failed' | 'sign-in' = 'failed',
  ): Response {
    recordAuthenticationFailure(
      request.headers.get('x-request-id'),
      'link_callback',
      reason,
      'refused',
    );
    return this.landing(outcome);
  }

  private landing(outcome: 'returned' | 'failed' | 'sign-in'): Response {
    const url = new URL(LINK_LANDINGS[outcome], this.input.baseUrl);
    // A late callback must not erase a newer link journey's browser binding.
    // The five-minute HttpOnly cookie expires naturally and cannot replay a
    // consumed state.
    return new Response(null, {
      status: HttpStatus.FOUND,
      headers: { location: url.toString() },
    });
  }
}

function problem(status: number, code = 'LINK_ATTEMPT_UNAVAILABLE'): Response {
  return Response.json({ code }, { status });
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
    (url.searchParams.get('iss')?.length ?? 0) >
      CALLBACK_LIMITS.issuerCharacters;
  return rejected;
}
