import { sealedPayload as sealedMailPayloadSchema } from './input.js';
import { authenticationMailAssociatedData } from '@pertexo/database/platform';
import { randomUUID } from 'node:crypto';

import type {
  SystemMailEnqueueStore,
  SystemMailInput,
  SealedSystemMailPayload,
  SystemMailPurpose,
} from '@pertexo/database/platform';
import type { ApplicationSecretEnvelope } from '@pertexo/integrations/server';

export type PreparedAuthenticationProofMail = Readonly<{
  id: string;
  purpose: 'verification' | 'email_change_confirmation' | 'password_reset';
  expiresAt: Date;
  sealedPayload: SealedSystemMailPayload;
}>;

export type AuthenticationSecurityNotice = Readonly<{
  purpose: 'two_factor_disabled' | 'recovery_code_sign_in';
  recipient: string;
  displayName: string;
  url: string;
}>;

export type AuthenticationMail = Readonly<{
  sendSecurityNotice(input: AuthenticationSecurityNotice): Promise<void>;
  prepareSecurityNotice?(input: AuthenticationSecurityNotice): SystemMailInput;
  prepareProof?(
    input: Readonly<{
      purpose: 'verification' | 'email_change_confirmation';
      recipient: string;
      displayName: string;
      url: string;
      expiresAt: Date;
      newEmail?: string;
    }>,
  ): PreparedAuthenticationProofMail;
  sendVerification(
    input: Readonly<{
      recipient: string;
      displayName: string;
      url: string;
    }>,
  ): Promise<void>;
  sendPasswordReset(
    input: Readonly<{
      recipient: string;
      displayName: string;
      url: string;
    }>,
  ): Promise<void>;
  sendEmailChangeConfirmation(
    input: Readonly<{
      recipient: string;
      displayName: string;
      newEmail: string;
      url: string;
    }>,
  ): Promise<void>;
}>;

export type LocalAuthenticationMailMessage = Readonly<{
  purpose:
    | 'verification'
    | 'password_reset'
    | 'email_change_confirmation'
    | AuthenticationSecurityNotice['purpose'];
  recipient: string;
  displayName: string;
  url: string;
  newEmail?: string;
  createdAt: Date;
}>;

/**
 * Non-persistent development/test sink. It never writes bearer URLs to logs;
 * in local development an observer may show each message to the developer.
 */
export class LocalAuthenticationMailSink implements AuthenticationMail {
  public constructor(
    private readonly observe?: (
      message: LocalAuthenticationMailMessage,
    ) => void,
  ) {}

  public sendSecurityNotice(
    input: AuthenticationSecurityNotice,
  ): Promise<void> {
    this.emit(input);
    return Promise.resolve();
  }

  public sendVerification(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    this.emit({ purpose: 'verification', ...input });
    return Promise.resolve();
  }

  public sendPasswordReset(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    this.emit({ purpose: 'password_reset', ...input });
    return Promise.resolve();
  }

  public sendEmailChangeConfirmation(input: {
    recipient: string;
    displayName: string;
    newEmail: string;
    url: string;
  }): Promise<void> {
    this.emit({ purpose: 'email_change_confirmation', ...input });
    return Promise.resolve();
  }

  private emit(input: Omit<LocalAuthenticationMailMessage, 'createdAt'>): void {
    const message = Object.freeze({ ...input, createdAt: new Date() });
    this.observe?.(message);
  }
}

/**
 * Shows a local message's link to the developer, since a local API sends no
 * mail. It writes to the process's own stdout rather than the structured log,
 * whose redaction would hide the token; configuration allows it only for
 * `AUTH_MAIL_MODE=local` in development.
 */
export function printLocalAuthenticationMail(
  message: LocalAuthenticationMailMessage,
  output: Pick<NodeJS.WritableStream, 'write'> = process.stdout,
): void {
  output.write(
    `\nLocal authentication mail (development only): ${message.purpose} for ${message.recipient}\n${message.url}\n\n`,
  );
}

export class DurableAuthenticationMail implements AuthenticationMail {
  public constructor(
    private readonly store: SystemMailEnqueueStore,
    private readonly envelope: Pick<ApplicationSecretEnvelope, 'seal'>,
    private readonly fromEmail: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public sendSecurityNotice(
    input: AuthenticationSecurityNotice,
  ): Promise<void> {
    return this.store.enqueue(this.prepareSecurityNotice(input));
  }

  /** The caller commits this sealed command with the security change. */
  public prepareSecurityNotice(
    input: AuthenticationSecurityNotice,
  ): SystemMailInput {
    const disabled = input.purpose === 'two_factor_disabled';
    return this.prepare(input.purpose, input.recipient, {
      subject: disabled
        ? 'Two-factor sign-in was turned off'
        : 'A recovery code was used to sign in',
      text: [
        `Hello ${input.displayName},`,
        '',
        disabled
          ? 'Two-factor sign-in was turned off for your Pertexo account.'
          : 'Someone signed in to your Pertexo account using a one-time recovery code.',
        '',
        'If this was not you, secure your account and contact your Pertexo operator immediately.',
        input.url,
      ].join('\n'),
      validityMillis: 24 * 60 * 60_000,
    });
  }

  public sendVerification(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    return this.enqueue('verification', input.recipient, {
      subject: 'Verify your Pertexo email',
      text: renderAuthenticationMail(
        input.displayName,
        'Verify your email to finish creating your Pertexo account.',
        input.url,
      ),
      validityMillis: 60 * 60_000,
    });
  }

  public sendPasswordReset(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    return this.enqueue('password_reset', input.recipient, {
      subject: 'Reset your Pertexo password',
      text: renderAuthenticationMail(
        input.displayName,
        'Use this time-limited link to reset your Pertexo password.',
        input.url,
      ),
      validityMillis: 60 * 60_000,
    });
  }

  public sendEmailChangeConfirmation(input: {
    recipient: string;
    displayName: string;
    newEmail: string;
    url: string;
  }): Promise<void> {
    return this.enqueue('email_change_confirmation', input.recipient, {
      subject: 'Confirm your Pertexo email change',
      text: renderAuthenticationMail(
        input.displayName,
        `Confirm changing your Pertexo email to ${input.newEmail}.`,
        input.url,
      ),
      validityMillis: 60 * 60_000,
    });
  }

  /** Prepare a sealed command for the proof transaction; do not enqueue it yet. */
  public prepareProof(input: {
    purpose: 'verification' | 'email_change_confirmation';
    recipient: string;
    displayName: string;
    url: string;
    expiresAt: Date;
    newEmail?: string;
  }): PreparedAuthenticationProofMail {
    const instruction =
      input.purpose === 'verification'
        ? 'Verify your Pertexo email address.'
        : `Confirm changing your Pertexo email to ${input.newEmail ?? ''}.`;
    return this.prepare(input.purpose, input.recipient, {
      subject:
        input.purpose === 'verification'
          ? 'Verify your Pertexo email'
          : 'Confirm your Pertexo email change',
      text: renderAuthenticationMail(input.displayName, instruction, input.url),
      validityMillis: input.expiresAt.getTime() - this.now().getTime(),
    });
  }

  private enqueue(
    purpose: SystemMailPurpose,
    recipient: string,
    {
      subject,
      text,
      validityMillis,
    }: Readonly<{ subject: string; text: string; validityMillis: number }>,
  ): Promise<void> {
    return this.store.enqueue(
      this.prepare(purpose, recipient, {
        subject: subject,
        text: text,
        validityMillis: validityMillis,
      }),
    );
  }

  private prepare<Purpose extends SystemMailPurpose>(
    purpose: Purpose,
    recipient: string,
    {
      subject,
      text,
      validityMillis,
    }: Readonly<{ subject: string; text: string; validityMillis: number }>,
  ): Readonly<{
    id: string;
    purpose: Purpose;
    expiresAt: Date;
    sealedPayload: SealedSystemMailPayload;
  }> {
    const id = randomUUID();
    const expiresAt = new Date(this.now().getTime() + validityMillis);
    const associatedData = authenticationMailAssociatedData(
      purpose,
      id,
      expiresAt,
    );
    const sealedPayload = sealedMailPayloadSchema.parse(
      this.envelope.seal(
        JSON.stringify({
          fromEmail: this.fromEmail,
          toEmail: recipient,
          subject,
          text,
        }),
        associatedData,
      ),
    );
    return { id, purpose, expiresAt, sealedPayload };
  }
}

function renderAuthenticationMail(
  displayName: string,
  instruction: string,
  url: string,
): string {
  return [
    `Hello ${displayName},`,
    '',
    instruction,
    url,
    '',
    'If you did not request this, you can ignore this message.',
  ].join('\n');
}
