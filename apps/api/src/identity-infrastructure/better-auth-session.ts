import { IdentityError } from '../identity/errors.js';
import type {
  AuthenticatedSession,
  SessionCookieBoundary,
  SessionIssueInput,
  SessionIssueResult,
} from '../identity/ports.js';
import type { SafeClientMetadata } from '../identity/types.js';
import type {
  BetterAuthRuntime,
  BetterAuthSessionDelivery,
} from './better-auth.js';

type BetterAuthCookieOptions = Readonly<{
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  ttlSeconds: number;
}>;

export class BetterAuthSessionService {
  public constructor(
    private readonly runtime: BetterAuthRuntime,
    private readonly cookieOptions: BetterAuthCookieOptions,
  ) {}

  public async issue(
    input: SessionIssueInput,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult> {
    const delivery = await this.runtime.sessions.issue(input.userId);
    try {
      await this.writeCookies(cookieBoundary, delivery);
    } catch {
      const token = sessionTokenFrom(delivery.setCookies);
      if (token !== undefined)
        await this.runtime.sessions.revokeToken(token).catch(() => undefined);
      throw new IdentityError('identity.session_invalid');
    }
    return resultFrom(delivery, this.cookieOptions);
  }

  public async deliver(
    token: string,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult> {
    const delivery = await this.runtime.sessions.deliver(token);
    await this.writeCookies(cookieBoundary, delivery);
    return resultFrom(delivery, this.cookieOptions);
  }

  public async authenticate(
    cookieValue: string,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<AuthenticatedSession> {
    try {
      const session = await this.runtime.sessions.authenticate(
        cookieValue,
        options.signal,
      );
      if (session === undefined)
        throw new IdentityError('identity.session_invalid');
      const clientMetadata: SafeClientMetadata = Object.freeze({
        ...(session.userAgent === undefined
          ? {}
          : { userAgent: session.userAgent }),
        ...(session.ipAddress === undefined
          ? {}
          : { ipAddress: session.ipAddress }),
      });
      return Object.freeze({
        userId: session.userId,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        clientMetadata,
      });
    } catch (error: unknown) {
      options.signal?.throwIfAborted();
      if (error instanceof IdentityError) throw error;
      throw new IdentityError('identity.session_invalid');
    }
  }

  public async revoke(cookieValue: string): Promise<void> {
    try {
      await this.runtime.sessions.revoke(cookieValue);
    } catch {
      throw new IdentityError('identity.session_invalid');
    }
  }

  private async writeCookies(
    boundary: SessionCookieBoundary,
    delivery: BetterAuthSessionDelivery,
  ): Promise<void> {
    if (boundary.writeSessionCookieHeaders === undefined)
      throw new Error('Better Auth cookie boundary is unavailable');
    await boundary.writeSessionCookieHeaders(delivery.setCookies, {
      httpOnly: true,
      secure: this.cookieOptions.secure,
      sameSite: this.cookieOptions.sameSite,
      path: '/',
      maxAgeSeconds: this.cookieOptions.ttlSeconds,
    });
  }
}

function resultFrom(
  delivery: BetterAuthSessionDelivery,
  options: BetterAuthCookieOptions,
): SessionIssueResult {
  return Object.freeze({
    sessionId: delivery.sessionId,
    expiresAt: delivery.expiresAt,
    cookieOptions: Object.freeze({
      httpOnly: true as const,
      secure: options.secure,
      sameSite: options.sameSite,
      path: '/' as const,
      maxAgeSeconds: options.ttlSeconds,
    }),
  });
}

function sessionTokenFrom(setCookies: readonly string[]): string | undefined {
  const prefix = 'pertexo_session=';
  const cookie = setCookies.find((candidate) => candidate.startsWith(prefix));
  if (cookie === undefined) return undefined;
  const encoded = cookie.slice(prefix.length).split(';', 1)[0];
  if (encoded === undefined) return undefined;
  const decoded = decodeURIComponent(encoded);
  const separator = decoded.lastIndexOf('.');
  return separator < 1 ? undefined : decoded.slice(0, separator);
}
