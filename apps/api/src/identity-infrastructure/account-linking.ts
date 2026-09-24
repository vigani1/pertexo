import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { accountSecurityLinkStartRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';
import type { authenticationProviderSchema } from '@pertexo/contracts/schemas/identity-workspace';

type ProviderName = z.infer<typeof authenticationProviderSchema>;
type BrowserSession = Readonly<{
  userId: string;
  sessionId: string;
  emailVerified: boolean;
}>;
type ProviderIdentity = Readonly<{
  accountId: string;
  email: string | null;
  emailVerified: boolean;
}>;

export type LinkProviderGateway = Readonly<{
  available: readonly ProviderName[];
  authorize(
    input: Readonly<{
      provider: ProviderName;
      state: string;
      codeVerifier: string;
      nonce: string;
      redirectUri: string;
    }>,
  ): Promise<string>;
  verify(
    input: Readonly<{
      provider: ProviderName;
      code: string;
      codeVerifier: string;
      nonce: string;
      redirectUri: string;
      issuer: string | null;
    }>,
  ): Promise<ProviderIdentity | undefined>;
}>;

type Attempt = Readonly<{
  id: string;
  user_id: string;
  session_id: string;
  browser_digest: Buffer;
  source_provider: string;
  target_provider: ProviderName;
  phase: 'source' | 'target' | 'completed' | 'abandoned';
  expires_at: Date;
}>;
type LinkCompletion =
  { kind: 'failed' } | { kind: 'already' } | { kind: 'linked'; token: string };

const LINK_COOKIE = 'pertexo_link';
const LINK_PATH = '/v1/auth/account-security/methods/link';

/** Owns only the two-sided linking journey; Better Auth still verifies providers. */
export class AccountLinking {
  public constructor(
    private readonly input: Readonly<{
      pool: Pool;
      secret: string;
      baseUrl: string;
      secureCookies: boolean;
      sessionTtlSeconds: number;
      providers: LinkProviderGateway;
      authenticate(request: Request): Promise<BrowserSession | undefined>;
      verifyPassword(userId: string, password: string): Promise<boolean>;
      deliver(token: string): Promise<readonly string[]>;
    }>,
  ) {}

  public async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${LINK_PATH}/`)) return undefined;
    if (url.pathname === `${LINK_PATH}/start` && request.method === 'POST')
      return this.start(request);
    const callback = new RegExp(
      `^${LINK_PATH}/callback/(google|github|microsoft|apple)$`,
      'u',
    ).exec(url.pathname);
    if (callback !== null && request.method === 'GET')
      return this.callback(request, callback[1] as ProviderName);
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
      const existing = await this.input.pool.query(
        `select 1 from app.auth_accounts
          where user_id=$1 and provider_id=$2 limit 1`,
        [session.userId, sourceProvider],
      );
      if (existing.rowCount !== 1) return problem(403);
    }
    const alreadyLinked = await this.input.pool.query(
      `select 1 from app.auth_accounts
        where user_id=$1 and provider_id=$2 limit 1`,
      [session.userId, provider],
    );
    if (alreadyLinked.rowCount !== 0) return problem(409);

    const attemptId = randomUUID();
    const binding = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const phase = sourceProvider === 'credential' ? 'target' : 'source';
    const activeProvider =
      phase === 'target' ? provider : (sourceProvider as ProviderName);
    const authorizationUrl = await this.authorizationUrl(
      attemptId,
      phase,
      activeProvider,
      state,
    ).catch(() => undefined);
    if (authorizationUrl === undefined) return problem(503);
    await this.input.pool.query(
      `insert into app.auth_method_link_attempts
        (id,user_id,session_id,browser_digest,source_provider,target_provider,
         phase,state_digest,expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 minutes')`,
      [
        attemptId,
        session.userId,
        session.sessionId,
        digest(binding),
        sourceProvider,
        provider,
        phase,
        digest(state),
      ],
    );
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', this.bindingCookie(binding));
    return new Response(JSON.stringify({ authorizationUrl }), {
      status: 200,
      headers,
    });
  }

  private async callback(
    request: Request,
    provider: ProviderName,
  ): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const binding = readCookie(request.headers, LINK_COOKIE);
    if (!isToken(state) || code.length === 0 || binding === undefined)
      return this.landing('failed');
    const session = await this.input.authenticate(request);
    if (session === undefined) return this.landing('sign-in');
    const found = await this.input.pool.query<Attempt>(
      `select id,user_id,session_id,browser_digest,source_provider,
              target_provider,phase,expires_at
         from app.auth_method_link_attempts
        where state_digest=$1 and expires_at>clock_timestamp()`,
      [digest(state)],
    );
    const attempt = found.rows[0];
    if (
      attempt?.user_id !== session.userId ||
      attempt.session_id !== session.sessionId ||
      !digest(binding).equals(attempt.browser_digest) ||
      (attempt.phase === 'source'
        ? attempt.source_provider
        : attempt.target_provider) !== provider
    )
      return this.landing('failed');
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

    if (attempt.phase === 'source') {
      const nextState = randomBytes(32).toString('base64url');
      const nextUrl = await this.authorizationUrl(
        attempt.id,
        'target',
        attempt.target_provider,
        nextState,
      ).catch(() => undefined);
      if (nextUrl === undefined) return this.landing('failed');
      const accepted = await this.updateSource(
        attempt,
        state,
        binding,
        identity,
        nextState,
      );
      return accepted
        ? Response.redirect(nextUrl, 302)
        : this.landing('failed');
    }
    const outcome = await this.completeTarget(
      attempt,
      state,
      binding,
      identity,
    );
    if (outcome.kind === 'failed') return this.landing('failed');
    if (outcome.kind === 'already') return this.landing('returned');
    try {
      const cookies = await this.input.deliver(outcome.token);
      const response = this.landing('returned');
      for (const cookie of cookies)
        response.headers.append('set-cookie', cookie);
      return response;
    } catch {
      // The provider identity was attached transactionally. The browser must
      // recover through ordinary sign-in; a callback retry cannot repeat it.
      return this.landing('sign-in');
    }
  }

  private async updateSource(
    attempt: Attempt,
    state: string,
    binding: string,
    identity: ProviderIdentity,
    nextState: string,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const user = await client.query(
        'select id from app.users where id=$1 and status=$2 for update',
        [attempt.user_id, 'active'],
      );
      if (
        user.rowCount !== 1 ||
        !(await this.sessionStillActive(client, attempt))
      )
        return false;
      const locked = await this.lockAttempt(client, attempt, state, binding);
      if (locked?.phase !== 'source') return false;
      const source = await client.query(
        `select 1 from app.auth_accounts
          where user_id=$1 and provider_id=$2 and account_id=$3`,
        [attempt.user_id, attempt.source_provider, identity.accountId],
      );
      if (source.rowCount !== 1) return false;
      // State is replaced before the next redirect; the old callback is dead.
      await client.query(
        `update app.auth_method_link_attempts
            set phase='target',state_digest=$2
          where id=$1`,
        [attempt.id, digest(nextState)],
      );
      return true;
    });
  }

  private async completeTarget(
    attempt: Attempt,
    state: string,
    binding: string,
    identity: ProviderIdentity,
  ): Promise<LinkCompletion> {
    if (!identity.emailVerified || identity.email === null)
      return { kind: 'failed' };
    return this.transaction<LinkCompletion>(async (client) => {
      const user = await client.query<{ status: string }>(
        'select status from app.users where id=$1 for update',
        [attempt.user_id],
      );
      if (
        user.rows[0]?.status !== 'active' ||
        !(await this.sessionStillActive(client, attempt))
      )
        return { kind: 'failed' };
      const locked = await this.lockAttempt(client, attempt, state, binding);
      if (locked?.phase !== 'target') return { kind: 'failed' };
      const owner = await client.query<{ user_id: string }>(
        `select user_id from app.auth_accounts
          where provider_id=$1 and account_id=$2`,
        [attempt.target_provider, identity.accountId],
      );
      if (owner.rows[0] !== undefined) {
        if (owner.rows[0].user_id !== attempt.user_id)
          return { kind: 'failed' };
        await client.query(
          `update app.auth_method_link_attempts
              set phase='completed',completed_at=clock_timestamp(),state_digest=null
            where id=$1`,
          [attempt.id],
        );
        return { kind: 'already' };
      }
      await client.query(
        `insert into app.auth_accounts
          (id,account_id,provider_id,user_id)
         values ($1,$2,$3,$4)`,
        [
          randomUUID(),
          identity.accountId,
          attempt.target_provider,
          attempt.user_id,
        ],
      );
      await client.query(
        `select app.record_identity_method_audit_fact($1,'method.linked')`,
        [attempt.user_id],
      );
      await client.query('delete from app.auth_sessions where user_id=$1', [
        attempt.user_id,
      ]);
      const token = randomBytes(32).toString('base64url');
      await client.query(
        `insert into app.auth_sessions (id,expires_at,token,user_id)
         values ($1,clock_timestamp()+($2::integer*interval '1 second'),$3,$4)`,
        [randomUUID(), this.input.sessionTtlSeconds, token, attempt.user_id],
      );
      await client.query(
        `update app.auth_method_link_attempts
            set phase='completed',completed_at=clock_timestamp(),state_digest=null
          where id=$1`,
        [attempt.id],
      );
      return { kind: 'linked', token };
    }).catch((error: unknown) => {
      if (isUniqueViolation(error)) return { kind: 'failed' };
      throw error instanceof Error
        ? error
        : new Error('Account linking failed');
    });
  }

  private async sessionStillActive(
    client: PoolClient,
    attempt: Attempt,
  ): Promise<boolean> {
    const session = await client.query(
      `select 1 from app.auth_sessions
        where id=$1 and user_id=$2 and expires_at>clock_timestamp()
        for update`,
      [attempt.session_id, attempt.user_id],
    );
    return session.rowCount === 1;
  }

  private async lockAttempt(
    client: PoolClient,
    attempt: Attempt,
    state: string,
    binding: string,
  ): Promise<Attempt | undefined> {
    const result = await client.query<Attempt>(
      `select id,user_id,session_id,browser_digest,source_provider,
              target_provider,phase,expires_at
         from app.auth_method_link_attempts
        where id=$1 and state_digest=$2 and expires_at>clock_timestamp()
        for update`,
      [attempt.id, digest(state)],
    );
    const locked = result.rows[0];
    if (
      locked?.user_id !== attempt.user_id ||
      locked.session_id !== attempt.session_id ||
      !locked.browser_digest.equals(digest(binding))
    )
      return undefined;
    return locked;
  }

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.input.pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async authorizationUrl(
    attemptId: string,
    phase: 'source' | 'target',
    provider: ProviderName,
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
    return createHmac('sha256', this.input.secret)
      .update(`pertexo-link:${id}:${phase}:${purpose}`)
      .digest('base64url');
  }

  private callbackUrl(provider: ProviderName): string {
    return new URL(
      `${LINK_PATH}/callback/${provider}`,
      this.input.baseUrl,
    ).toString();
  }

  private bindingCookie(binding: string): string {
    return `${LINK_COOKIE}=${binding}; Path=${LINK_PATH}; HttpOnly; SameSite=Lax; Max-Age=300${this.input.secureCookies ? '; Secure' : ''}`;
  }

  private landing(outcome: 'returned' | 'failed' | 'sign-in'): Response {
    const url = new URL(
      outcome === 'sign-in'
        ? '/login?error=link_reauthenticate'
        : outcome === 'returned'
          ? '/account/security?linked=true'
          : '/account/security?linkError=true',
      this.input.baseUrl,
    );
    // A late callback must not erase a newer link journey's browser binding.
    // The five-minute HttpOnly cookie expires naturally and cannot replay a
    // consumed state.
    return new Response(null, {
      status: 302,
      headers: { location: url.toString() },
    });
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function readCookie(headers: Headers, name: string): string | undefined {
  return headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
