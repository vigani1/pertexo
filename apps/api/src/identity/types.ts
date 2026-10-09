export type SafeClientMetadata = Readonly<{
  userAgent?: string;
  ipAddress?: string;
  requestId?: string;
}>;

export type SessionLookup = Readonly<{
  userId: string;
  sessionId: string;
  expiresAt: Date;
  clientMetadata: SafeClientMetadata;
}>;

export type SessionCookieOptions = Readonly<{
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: '/';
  maxAgeSeconds: number;
}>;
