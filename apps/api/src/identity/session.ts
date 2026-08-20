import { z } from 'zod';

import {
  encodeBase64Url,
  digestSha256Hex,
  nodeIdentityCrypto,
  randomUuid,
} from './crypto.js';
import { IdentityError } from './errors.js';
import type {
  IdentityClock,
  AuthenticatedSession,
  SessionCookieBoundary,
  SessionIssueInput,
  SessionIssueResult,
  SessionStorePort,
} from './ports.js';
import {
  safeClientMetadataSchema,
  sessionRecordSchema,
  type SafeClientMetadata,
} from './types.js';
import type { IdentityCrypto } from './crypto.js';

const sessionOptionsSchema = z
  .object({
    ttlMillis: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 60 * 60_000)
      .default(8 * 60 * 60_000),
    secureCookie: z.boolean().default(true),
    sameSite: z.enum(['lax', 'strict', 'none']).default('lax'),
  })
  .superRefine((value, context) => {
    if (value.sameSite === 'none' && !value.secureCookie) {
      context.addIssue({
        code: 'custom',
        message: 'SameSite=None requires Secure cookies',
        path: ['secureCookie'],
      });
    }
  });

type SessionOptions = z.output<typeof sessionOptionsSchema>;
type MetadataInput = Readonly<{
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
  requestId?: string | undefined;
}>;

const systemClock: IdentityClock = { now: () => new Date() };

/** Platform-owned opaque sessions. Persistence receives only a digest and safe metadata. */
export class OpaqueSessionService {
  private readonly options: SessionOptions;
  private readonly crypto: IdentityCrypto;
  private readonly clock: IdentityClock;

  constructor(
    private readonly store: SessionStorePort,
    options: Readonly<{
      ttlMillis?: number;
      secureCookie?: boolean;
      sameSite?: 'lax' | 'strict' | 'none';
      crypto?: IdentityCrypto;
      clock?: IdentityClock;
    }> = {},
  ) {
    try {
      this.options = sessionOptionsSchema.parse(options);
    } catch {
      throw new IdentityError('identity.invalid_input');
    }
    this.crypto = options.crypto ?? nodeIdentityCrypto;
    this.clock = options.clock ?? systemClock;
  }

  async issue(
    input: SessionIssueInput,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult> {
    if (
      typeof input.userId !== 'string' ||
      !z.uuid().safeParse(input.userId).success
    ) {
      throw new IdentityError('identity.invalid_input');
    }
    const clientMetadata = this.parseMetadata(input.clientMetadata);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.options.ttlMillis);
    if (
      !isValidDate(now) ||
      !isValidDate(expiresAt) ||
      expiresAt.getTime() <= now.getTime()
    ) {
      throw new IdentityError('identity.invalid_input');
    }
    const rawToken = encodeBase64Url(this.crypto.randomBytes(32));
    const record = Object.freeze({
      sessionId: randomUuid(this.crypto),
      tokenDigest: digestSha256Hex(rawToken, this.crypto),
      userId: input.userId,
      expiresAt,
      clientMetadata,
    });
    try {
      await this.store.create(record);
    } catch {
      throw new IdentityError('identity.session_invalid');
    }

    const cookieOptions = Object.freeze({
      httpOnly: true as const,
      secure: this.options.secureCookie,
      sameSite: this.options.sameSite,
      path: '/' as const,
      maxAgeSeconds: Math.ceil(this.options.ttlMillis / 1_000),
    });
    // This is the sole raw-token handoff. It is intentionally not part of the result or record.
    try {
      await cookieBoundary.writeSessionCookie(rawToken, cookieOptions);
    } catch {
      try {
        await this.store.revokeByDigest(record.tokenDigest, this.clock.now());
      } catch {
        // The safe delivery error below remains authoritative; never expose token or digest data.
      }
      throw new IdentityError('identity.session_invalid');
    }
    return Object.freeze({
      sessionId: record.sessionId,
      expiresAt,
      cookieOptions,
    });
  }

  async authenticate(rawToken: string): Promise<AuthenticatedSession> {
    const digest = this.parseTokenDigest(rawToken);
    let record;
    try {
      record = await this.store.findByDigest(digest);
    } catch {
      throw new IdentityError('identity.session_invalid');
    }
    if (record === undefined) {
      throw new IdentityError('identity.session_invalid');
    }
    let validatedRecord;
    try {
      validatedRecord = sessionRecordSchema.parse(record);
    } catch {
      throw new IdentityError('identity.session_invalid');
    }
    const now = this.clock.now();
    if (!isValidDate(now)) {
      throw new IdentityError('identity.session_invalid');
    }
    if (validatedRecord.revokedAt !== undefined) {
      throw new IdentityError('identity.session_revoked');
    }
    if (now.getTime() >= validatedRecord.expiresAt.getTime()) {
      throw new IdentityError('identity.session_expired');
    }
    return Object.freeze({
      userId: validatedRecord.userId,
      sessionId: validatedRecord.sessionId,
      expiresAt: new Date(validatedRecord.expiresAt.getTime()),
      clientMetadata: this.parseMetadata(validatedRecord.clientMetadata),
    });
  }

  async revoke(rawToken: string): Promise<void> {
    const digest = this.parseTokenDigest(rawToken);
    try {
      await this.store.revokeByDigest(digest, this.clock.now());
    } catch {
      throw new IdentityError('identity.session_invalid');
    }
  }

  async rotate(
    rawToken: string,
    cookieBoundary: SessionCookieBoundary,
    clientMetadata?: SafeClientMetadata,
  ): Promise<SessionIssueResult> {
    const session = await this.authenticate(rawToken);
    await this.revoke(rawToken);
    return this.issue(
      {
        userId: session.userId,
        ...(clientMetadata === undefined ? {} : { clientMetadata }),
      },
      cookieBoundary,
    );
  }

  private parseTokenDigest(rawToken: string): string {
    if (
      typeof rawToken !== 'string' ||
      rawToken.length < 32 ||
      rawToken.length > 512
    ) {
      throw new IdentityError('identity.session_invalid');
    }
    return digestSha256Hex(rawToken, this.crypto);
  }

  private parseMetadata(
    metadata: MetadataInput | undefined,
  ): SafeClientMetadata {
    try {
      const parsed = safeClientMetadataSchema.parse(metadata ?? {});
      return Object.freeze({
        ...(parsed.userAgent === undefined
          ? {}
          : { userAgent: parsed.userAgent }),
        ...(parsed.ipAddress === undefined
          ? {}
          : { ipAddress: parsed.ipAddress }),
        ...(parsed.requestId === undefined
          ? {}
          : { requestId: parsed.requestId }),
      });
    } catch {
      throw new IdentityError('identity.invalid_input');
    }
  }
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}
