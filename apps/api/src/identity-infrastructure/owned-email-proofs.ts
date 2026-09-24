import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { z } from 'zod';

import {
  disabledAuthenticationMail,
  type AuthenticationMail,
  type PreparedAuthenticationProofMail,
} from './authentication-mail.js';

type ProofPurpose = 'initial_verification' | 'change_old' | 'change_new';
type ProofUser = Readonly<{ id: string; email: string; name: string }>;

const SIGN_UP_PATH = '/v1/auth/sign-up/email';
const VERIFY_EMAIL_PATH = '/v1/auth/verify-email';
const signUpResponseSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.email(), name: z.string() }),
});

/**
 * Pertexo owns email proofs end to end: browser links carry only random proof
 * material, consumption and the protected mutations stay in SQL, and Better
 * Auth's stateless native verification route is never reached.
 */
export class OwnedEmailProofs {
  public constructor(
    private readonly pool: Pool,
    private readonly mail: AuthenticationMail,
    private readonly baseUrl: string,
  ) {}

  /** Serves the verification link and lands the browser on sign-in. */
  public async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== VERIFY_EMAIL_PATH) return undefined;
    const outcome =
      request.method === 'GET'
        ? await this.consume(url.searchParams.get('token') ?? '')
        : 'invalid';
    const landing = new URL('/login', this.baseUrl);
    if (outcome === 'initial_verification')
      landing.searchParams.set('verified', 'true');
    else if (outcome === 'change_old')
      landing.searchParams.set('emailChangePending', 'true');
    else if (outcome === 'change_new')
      landing.searchParams.set('emailChanged', 'true');
    else landing.searchParams.set('error', 'verification_invalid');
    return Response.redirect(landing, 302);
  }

  /** Better Auth's verification hook; native sign-up waits for its commit. */
  public async issueVerification(
    user: ProofUser,
    request: Request | undefined,
  ): Promise<void> {
    if (request !== undefined && new URL(request.url).pathname === SIGN_UP_PATH)
      return;
    await this.issue(user, 'initial_verification');
  }

  /** Issues the first proof once native sign-up has committed the user. */
  public async issueAfterSignUp(
    request: Request,
    response: Response,
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
      await this.issue(parsed.data.user, 'initial_verification');
  }

  public async issue(
    user: ProofUser,
    purpose: 'initial_verification' | 'change_old',
    newEmail?: string,
  ): Promise<void> {
    if (this.mail === disabledAuthenticationMail)
      throw new Error('Authentication mail delivery is not configured');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 55 * 60_000);
    const url = this.url(token);
    const mailInput = {
      purpose:
        purpose === 'change_old' ? 'email_change_confirmation' : 'verification',
      recipient: user.email,
      displayName: user.name,
      url,
      expiresAt,
      ...(newEmail === undefined ? {} : { newEmail }),
    } as const;
    const prepared = this.mail.prepareProof?.(mailInput);
    const result = await this.pool.query<{ issued: boolean }>(
      `select app.issue_auth_email_proof(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
       ) issued`,
      [
        randomUUID(),
        digest(token),
        user.id,
        purpose,
        user.email,
        newEmail ?? null,
        expiresAt,
        prepared?.id ?? null,
        prepared?.purpose ?? null,
        prepared?.expiresAt ?? null,
        prepared?.sealedPayload.ciphertext ?? null,
        prepared?.sealedPayload.nonce ?? null,
        prepared?.sealedPayload.tag ?? null,
        prepared?.sealedPayload.keyVersion ?? null,
      ],
    );
    if (result.rows[0]?.issued !== true || prepared !== undefined) return;
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
    const inspected = await this.pool.query<{
      purpose: ProofPurpose;
      new_email: string | null;
      display_name: string;
    }>('select * from app.inspect_auth_email_proof($1)', [tokenDigest]);
    const proof = inspected.rows[0];
    if (proof === undefined) return 'invalid';
    let nextToken: string | undefined;
    let nextExpiresAt: Date | undefined;
    let nextMail: PreparedAuthenticationProofMail | undefined;
    let nextUrl: string | undefined;
    if (proof.purpose === 'change_old') {
      if (proof.new_email === null || this.mail === disabledAuthenticationMail)
        return 'invalid';
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
    const result = await this.pool.query<{ outcome: ProofPurpose | 'invalid' }>(
      `select app.consume_auth_email_proof(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
       ) outcome`,
      [
        tokenDigest,
        nextToken === undefined ? null : randomUUID(),
        nextToken === undefined ? null : digest(nextToken),
        nextExpiresAt ?? null,
        nextMail?.id ?? null,
        nextMail?.expiresAt ?? null,
        nextMail?.sealedPayload.ciphertext ?? null,
        nextMail?.sealedPayload.nonce ?? null,
        nextMail?.sealedPayload.tag ?? null,
        nextMail?.sealedPayload.keyVersion ?? null,
      ],
    );
    const outcome = result.rows[0]?.outcome ?? 'invalid';
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

  private url(token: string): string {
    const url = new URL(VERIFY_EMAIL_PATH, this.baseUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
