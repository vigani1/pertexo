import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import {
  authenticationProviderSchema,
  legacyMethodMigrationStartRequestSchema,
  legacyMethodMigrationStartResponseSchema,
} from '@pertexo/contracts/schemas/identity-workspace';

import type { OidcLoginService } from '../identity/oidc.js';
import type { LinkProviderGateway } from './account-linking.js';

type ProviderName = z.infer<typeof authenticationProviderSchema>;
type Attempt = Readonly<{
  id: string;
  browser_digest: Buffer;
  oidc_state_digest: Buffer;
  target_state_digest: Buffer | null;
  target_provider: ProviderName;
  legacy_identity_id: string | null;
  user_id: string | null;
  phase: 'legacy' | 'target' | 'completed' | 'abandoned';
  expires_at: Date;
}>;

const PATH = '/v1/auth/legacy-migration';
const BROWSER_COOKIE = 'pertexo_legacy_migration';
const OIDC_COOKIE = 'pertexo_legacy_oidc';
const FIVE_MINUTES = 5 * 60_000;

/** The old issuer is proof, never a second browser-session authority. */
export class LegacyMethodMigration {
  public constructor(
    private readonly input: Readonly<{
      pool: Pool;
      oidc: OidcLoginService;
      providers: LinkProviderGateway;
      secret: string;
      baseUrl: string;
      secureCookies: boolean;
      sessionTtlSeconds: number;
      deliver(token: string): Promise<readonly string[]>;
    }>,
  ) {}

  public async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${PATH}/`)) return undefined;
    if (url.pathname === `${PATH}/start` && request.method === 'POST')
      return this.start(request);
    if (url.pathname === `${PATH}/oidc/callback` && request.method === 'GET')
      return this.completeOldProof(request);
    const target = new RegExp(
      `^${PATH}/provider/callback/(google|github|microsoft|apple)$`,
      'u',
    ).exec(url.pathname);
    if (target !== null && request.method === 'GET')
      return this.completeNewProof(
        request,
        authenticationProviderSchema.parse(target[1]),
      );
    return new Response(null, { status: 404 });
  }

  private async start(request: Request): Promise<Response> {
    const body = legacyMethodMigrationStartRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success) return problem(400);
    const provider = body.data.provider;
    if (!this.input.providers.available.includes(provider)) return problem(404);
    const browserBinding = randomBytes(32).toString('base64url');
    const oidc = await this.input.oidc.startLogin().catch(() => undefined);
    if (oidc === undefined) return problem(503);
    const state =
      new URL(oidc.authorizationUrl).searchParams.get('state') ?? '';
    if (!isToken(state)) return problem(503);
    const expiry = new Date(
      Math.min(oidc.expiresAt.getTime(), Date.now() + FIVE_MINUTES),
    );
    await this.input.pool.query(
      `insert into app.auth_legacy_method_migration_attempts
        (id,browser_digest,oidc_state_digest,target_provider,expires_at)
       values ($1,$2,$3,$4,$5)`,
      [randomUUID(), digest(browserBinding), digest(state), provider, expiry],
    );
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append(
      'set-cookie',
      this.cookie(BROWSER_COOKIE, browserBinding, PATH),
    );
    headers.append(
      'set-cookie',
      this.cookie(OIDC_COOKIE, oidc.browserBinding, `${PATH}/oidc/callback`),
    );
    return Response.json(
      legacyMethodMigrationStartResponseSchema.parse({
        authorizationUrl: oidc.authorizationUrl,
        expiresAt: expiry.toISOString(),
      }),
      { headers },
    );
  }

  private async completeOldProof(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const browserBinding = readCookie(request.headers, BROWSER_COOKIE);
    const oidcBinding = readCookie(request.headers, OIDC_COOKIE);
    if (
      !isToken(state) ||
      code.length === 0 ||
      browserBinding === undefined ||
      oidcBinding === undefined
    )
      return this.landing('failed');
    const lookup = await this.input.pool.query<Attempt>(
      `select * from app.auth_legacy_method_migration_attempts
        where oidc_state_digest=$1 and phase='legacy'
          and expires_at>clock_timestamp()`,
      [digest(state)],
    );
    const attempt = lookup.rows[0];
    if (!attempt?.browser_digest.equals(digest(browserBinding)))
      return this.landing('failed');
    // The mapper for this service is read-only: an unknown legacy subject
    // cannot create or claim a Pertexo user during proof validation.
    const proof = await this.input.oidc
      .completeLogin({ state, code }, oidcBinding)
      .catch(() => undefined);
    if (proof === undefined) return this.landing('failed');
    const targetState = randomBytes(32).toString('base64url');
    const authorizationUrl = await this.input.providers
      .authorize({
        provider: attempt.target_provider,
        state: targetState,
        codeVerifier: this.derived(attempt.id, 'pkce'),
        nonce: this.derived(attempt.id, 'nonce'),
        redirectUri: this.providerCallbackUrl(attempt.target_provider),
      })
      .catch(() => undefined);
    if (authorizationUrl === undefined) return this.landing('failed');
    const accepted = await this.transaction(async (client) => {
      const user = await client.query<{ status: string }>(
        'select status from app.users where id=$1 for update',
        [proof.internalIdentity.userId],
      );
      if (user.rows[0]?.status !== 'active') return false;
      const locked = await client.query<Attempt>(
        `select * from app.auth_legacy_method_migration_attempts
          where id=$1 and phase='legacy' and oidc_state_digest=$2
            and expires_at>clock_timestamp() for update`,
        [attempt.id, digest(state)],
      );
      if (!locked.rows[0]?.browser_digest.equals(digest(browserBinding)))
        return false;
      const identity = await client.query<{ id: string }>(
        `select id from app.auth_identities
          where issuer=$1 and provider_subject=$2 and user_id=$3`,
        [
          proof.externalIdentity.issuer,
          proof.externalIdentity.subject,
          proof.internalIdentity.userId,
        ],
      );
      const identityId = identity.rows[0]?.id;
      if (identityId === undefined) return false;
      await client.query(
        `update app.auth_legacy_method_migration_attempts
            set phase='target',target_state_digest=$2,user_id=$3,legacy_identity_id=$4
          where id=$1`,
        [
          attempt.id,
          digest(targetState),
          proof.internalIdentity.userId,
          identityId,
        ],
      );
      return true;
    });
    return accepted
      ? Response.redirect(authorizationUrl, 302)
      : this.landing('failed');
  }

  private async completeNewProof(
    request: Request,
    provider: ProviderName,
  ): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const browserBinding = readCookie(request.headers, BROWSER_COOKIE);
    if (!isToken(state) || code.length === 0 || browserBinding === undefined)
      return this.landing('failed');
    const lookup = await this.input.pool.query<Attempt>(
      `select * from app.auth_legacy_method_migration_attempts
        where target_state_digest=$1 and phase='target'
          and target_provider=$2 and expires_at>clock_timestamp()`,
      [digest(state), provider],
    );
    const attempt = lookup.rows[0];
    if (
      !attempt?.user_id ||
      !attempt.legacy_identity_id ||
      !attempt.browser_digest.equals(digest(browserBinding))
    )
      return this.landing('failed');
    const verified = await this.input.providers
      .verify({
        provider,
        code,
        codeVerifier: this.derived(attempt.id, 'pkce'),
        nonce: this.derived(attempt.id, 'nonce'),
        redirectUri: this.providerCallbackUrl(provider),
        issuer: url.searchParams.get('iss'),
      })
      .catch(() => undefined);
    if (
      verified === undefined ||
      !verified.emailVerified ||
      verified.email === null
    )
      return this.landing('failed');
    const outcome = await this.transaction(async (client) => {
      const user = await client.query<{ status: string }>(
        'select status from app.users where id=$1 for update',
        [attempt.user_id],
      );
      if (user.rows[0]?.status !== 'active') return { kind: 'failed' } as const;
      const locked = await client.query<Attempt>(
        `select * from app.auth_legacy_method_migration_attempts
          where id=$1 and target_state_digest=$2 and phase='target'
            and expires_at>clock_timestamp() for update`,
        [attempt.id, digest(state)],
      );
      if (!locked.rows[0]?.browser_digest.equals(digest(browserBinding)))
        return { kind: 'failed' } as const;
      const oldIdentity = await client.query(
        `select 1 from app.auth_identities
          where id=$1 and user_id=$2`,
        [attempt.legacy_identity_id, attempt.user_id],
      );
      if (oldIdentity.rowCount !== 1) return { kind: 'failed' } as const;
      const owner = await client.query<{ user_id: string }>(
        `select user_id from app.auth_accounts
          where provider_id=$1 and account_id=$2`,
        [provider, verified.accountId],
      );
      if (owner.rows[0] !== undefined) return { kind: 'failed' } as const;
      await client.query(
        `insert into app.auth_accounts(id,account_id,provider_id,user_id)
         values($1,$2,$3,$4)`,
        [randomUUID(), verified.accountId, provider, attempt.user_id],
      );
      await client.query(
        `select app.record_identity_method_audit_fact($1,'legacy.method_migrated')`,
        [attempt.user_id],
      );
      await client.query(
        `update app.auth_identities
            set native_method_verified_at=clock_timestamp()
          where id=$1 and user_id=$2`,
        [attempt.legacy_identity_id, attempt.user_id],
      );
      await client.query(
        `update app.sessions set revoked_at=coalesce(revoked_at,clock_timestamp())
          where user_id=$1`,
        [attempt.user_id],
      );
      await client.query('delete from app.auth_sessions where user_id=$1', [
        attempt.user_id,
      ]);
      const token = randomBytes(32).toString('base64url');
      await client.query(
        `insert into app.auth_sessions(id,expires_at,token,user_id)
         values($1,clock_timestamp()+($2::integer*interval '1 second'),$3,$4)`,
        [randomUUID(), this.input.sessionTtlSeconds, token, attempt.user_id],
      );
      await client.query(
        `update app.auth_legacy_method_migration_attempts
            set phase='completed',completed_at=clock_timestamp(),target_state_digest=null
          where id=$1`,
        [attempt.id],
      );
      return { kind: 'migrated', token } as const;
    }).catch((error: unknown) => {
      if (isUniqueViolation(error)) return { kind: 'failed' as const };
      throw error instanceof Error
        ? error
        : new Error('Legacy migration failed');
    });
    if (outcome.kind === 'failed') return this.landing('failed');
    try {
      const cookies = await this.input.deliver(outcome.token);
      const response = this.landing('completed');
      for (const cookie of cookies)
        response.headers.append('set-cookie', cookie);
      return response;
    } catch {
      return this.landing('sign-in');
    }
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

  private derived(id: string, purpose: string): string {
    return createHmac('sha256', this.input.secret)
      .update(`pertexo-legacy-migration:${id}:${purpose}`)
      .digest('base64url');
  }

  private providerCallbackUrl(provider: ProviderName): string {
    return new URL(
      `${PATH}/provider/callback/${provider}`,
      this.input.baseUrl,
    ).toString();
  }

  private cookie(name: string, value: string, path: string): string {
    return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=300${this.input.secureCookies ? '; Secure' : ''}`;
  }

  private landing(outcome: 'completed' | 'failed' | 'sign-in'): Response {
    const path =
      outcome === 'completed'
        ? '/workspaces'
        : outcome === 'sign-in'
          ? '/login?error=migration_reauthenticate'
          : '/login?error=migration_failed';
    // A late response must not clear a newer tab's binding cookie.
    return new Response(null, {
      status: 302,
      headers: { location: new URL(path, this.input.baseUrl).toString() },
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

function problem(status: number): Response {
  return Response.json({ code: 'MIGRATION_UNAVAILABLE' }, { status });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
