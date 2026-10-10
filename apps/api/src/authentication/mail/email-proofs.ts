import { createHash, randomBytes } from 'node:crypto';

import { authenticationReturnPathSchema } from '@pertexo/contracts';
import { EmailProofCommands } from '@pertexo/database/tenant-access';
import type { Pool } from 'pg';
import { z } from 'zod';

import type {
  AuthenticationMail,
  PreparedAuthenticationProofMail,
} from './delivery.js';

type ProofPurpose = 'initial_verification' | 'change_old' | 'change_new';
type ProofUser = Readonly<{ id: string; email: string; name: string }>;

const SIGN_UP_PATH = '/v1/auth/sign-up/email';
const VERIFY_EMAIL_PATH = '/v1/auth/verify-email';
const signUpResponseSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.email(), name: z.string() }),
});

/**
 * Pertexo owns email proofs end to end: browser links carry only random proof
 * material, a proof is consumed with its user locked in one transaction, and
 * Better Auth's stateless native verification route is never reached.
 */
export class OwnedEmailProofs {
  private readonly commands: EmailProofCommands;
  public constructor(
    pool: Pool,
    private readonly mail: AuthenticationMail,
    private readonly baseUrl: string,
  ) {
    this.commands = new EmailProofCommands(pool);
  }

  /**
   * Serves the verification link and lands the browser on sign-in. A first
   * verification keeps an allowlisted return path for after sign-in; the
   * landing itself is always this origin's sign-in page.
   */
  public async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== VERIFY_EMAIL_PATH) return undefined;
    const outcome =
      request.method === 'GET'
        ? await this.consume(url.searchParams.get('token') ?? '')
        : 'invalid';
    const landing = new URL('/login', this.baseUrl);
    const returnTo = allowlistedReturnPath(url.searchParams.get('returnTo'));
    if (outcome === 'initial_verification') {
      landing.searchParams.set('verified', 'true');
      if (returnTo !== undefined)
        landing.searchParams.set('returnTo', returnTo);
    } else if (outcome === 'change_old')
      landing.searchParams.set('emailChangePending', 'true');
    else if (outcome === 'change_new')
      landing.searchParams.set('emailChanged', 'true');
    else landing.searchParams.set('error', 'verification_invalid');
    return Response.redirect(landing, 302);
  }

  /**
   * Better Auth's verification hook; native sign-up waits for its commit. A
   * resend keeps the return path from its native callback URL.
   */
  public async issueVerification(
    user: ProofUser,
    request: Request | undefined,
    nativeUrl?: string,
  ): Promise<void> {
    if (request !== undefined && new URL(request.url).pathname === SIGN_UP_PATH)
      return;
    const callbackURL =
      nativeUrl === undefined
        ? undefined
        : new URL(nativeUrl).searchParams.get('callbackURL');
    await this.issue(
      user,
      'initial_verification',
      undefined,
      this.returnPathFrom(callbackURL),
    );
  }

  /** The return path a sign-up asked for, read before its body is consumed. */
  public async signUpReturnPath(request: Request): Promise<string | undefined> {
    if (
      new URL(request.url).pathname !== SIGN_UP_PATH ||
      request.method !== 'POST'
    )
      return undefined;
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => undefined);
    return typeof body === 'object' && body !== null && 'callbackURL' in body
      ? this.returnPathFrom(body.callbackURL)
      : undefined;
  }

  /** Issues the first proof once native sign-up has committed the user. */
  public async issueAfterSignUp(
    request: Request,
    response: Response,
    returnTo?: string,
  ): Promise<void> {
    if (
      new URL(request.url).pathname !== SIGN_UP_PATH ||
      request.method !== 'POST' ||
      !response.ok
    )
      return;
    const parsed = signUpResponseSchema.safeParse(
      await response.clone().json(),
    );
    if (parsed.success)
      await this.issue(
        parsed.data.user,
        'initial_verification',
        undefined,
        returnTo,
      );
  }

  public async issue(
    user: ProofUser,
    purpose: 'initial_verification' | 'change_old',
    newEmail?: string,
    returnTo?: string,
  ): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 55 * 60_000);
    const url = this.url(token, returnTo);
    const mailInput = {
      purpose:
        purpose === 'change_old' ? 'email_change_confirmation' : 'verification',
      recipient: user.email,
      displayName: user.name,
      url,
      expiresAt,
      ...(newEmail === undefined ? {} : { newEmail }),
    } as const;
    if (
      purpose === 'change_old' &&
      (newEmail === undefined ||
        newEmail.toLowerCase() === user.email.toLowerCase())
    )
      throw new TypeError('An email change needs a different address');
    const prepared = this.mail.prepareProof?.(mailInput);
    // A proof is issued only for the user's current address, while it still
    // needs this proof: unverified for a first verification, verified for a
    // change.
    const issued = await this.commands.issue(
      user,
      purpose,
      digest(token),
      newEmail,
      expiresAt,
      prepared,
    );
    if (!issued || prepared !== undefined) return;
    if (purpose === 'change_old')
      await this.mail.sendEmailChangeConfirmation({
        recipient: user.email,
        displayName: user.name,
        newEmail: newEmail ?? '',
        url,
      });
    else
      await this.mail.sendVerification({
        recipient: user.email,
        displayName: user.name,
        url,
      });
  }

  public async consume(token: string): Promise<ProofPurpose | 'invalid'> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return 'invalid';
    const tokenDigest = digest(token);
    const proof = await this.commands.inspect(tokenDigest);
    if (proof === undefined) return 'invalid';
    let nextToken: string | undefined;
    let nextExpiresAt: Date | undefined;
    let nextMail: PreparedAuthenticationProofMail | undefined;
    let nextUrl: string | undefined;
    if (proof.purpose === 'change_old') {
      if (proof.new_email === null) return 'invalid';
      nextToken = randomBytes(32).toString('base64url');
      nextExpiresAt = new Date(Date.now() + 55 * 60_000);
      nextUrl = this.url(nextToken);
      nextMail = this.mail.prepareProof?.({
        purpose: 'verification',
        recipient: proof.new_email,
        displayName: proof.display_name,
        url: nextUrl,
        expiresAt: nextExpiresAt,
      });
    }
    const next =
      nextToken === undefined || nextExpiresAt === undefined
        ? undefined
        : { digest: digest(nextToken), expiresAt: nextExpiresAt };
    const outcome = await this.commands.consume(tokenDigest, next, nextMail);
    if (
      outcome === 'change_old' &&
      nextMail === undefined &&
      proof.new_email !== null &&
      nextUrl !== undefined
    ) {
      await this.mail.sendVerification({
        recipient: proof.new_email,
        displayName: proof.display_name,
        url: nextUrl,
      });
    }
    return outcome;
  }

  private url(token: string, returnTo?: string): string {
    const url = new URL(VERIFY_EMAIL_PATH, this.baseUrl);
    url.searchParams.set('token', token);
    if (returnTo !== undefined) url.searchParams.set('returnTo', returnTo);
    return url.toString();
  }

  /**
   * Accepts only this origin's sign-in callback, and from it only an
   * allowlisted app path; anything else is dropped rather than redirected.
   */
  private returnPathFrom(callbackURL: unknown): string | undefined {
    if (typeof callbackURL !== 'string') return undefined;
    const origin = new URL(this.baseUrl).origin;
    const parsed = URL.canParse(callbackURL, origin)
      ? new URL(callbackURL, origin)
      : undefined;
    if (parsed?.origin !== origin || parsed.pathname !== '/login')
      return undefined;
    return allowlistedReturnPath(parsed.searchParams.get('returnTo'));
  }
}

function allowlistedReturnPath(value: string | null): string | undefined {
  const parsed = authenticationReturnPathSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
