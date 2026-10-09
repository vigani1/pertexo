import type {
  SafeClientMetadata,
  SessionCookieOptions,
  SessionLookup,
} from './types.js';

export interface SessionCookieBoundary {
  writeSessionCookieHeaders(
    setCookies: readonly string[],
    options: SessionCookieOptions,
  ): void | Promise<void>;
}

export interface IdentityClock {
  now(): Date;
}

export type SessionIssueInput = Readonly<{
  userId: string;
  clientMetadata?: SafeClientMetadata;
}>;

export type SessionIssueResult = Readonly<{
  sessionId: string;
  expiresAt: Date;
  cookieOptions: SessionCookieOptions;
}>;

export type AuthenticatedSession = SessionLookup;

/** The verified identity behind a browser session and when it was issued. */
export type SignInEvidence = Readonly<{
  userId: string;
  email: string;
  emailVerified: boolean;
  signedInAt: Date;
}>;
