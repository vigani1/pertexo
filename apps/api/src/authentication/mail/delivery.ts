import { randomUUID } from 'node:crypto';

import type {
  AuthenticationMailEnqueueStore,
  SealedAuthenticationMailPayload,
} from '@pertexo/database/identity';
import type { ApplicationSecretEnvelope } from '@pertexo/integrations/server';

export type PreparedAuthenticationProofMail = Readonly<{
  id: string;
  purpose: 'verification' | 'email_change_confirmation' | 'password_reset';
  expiresAt: Date;
  sealedPayload: SealedAuthenticationMailPayload;
}>;

export type AuthenticationMail = Readonly<{
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
  purpose: 'verification' | 'password_reset' | 'email_change_confirmation';
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
  private readonly messages: LocalAuthenticationMailMessage[] = [];

  public constructor(
    private readonly observe?: (
      message: LocalAuthenticationMailMessage,
    ) => void,
  ) {}

  public sendVerification(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    this.keep({ purpose: 'verification', ...input });
    return Promise.resolve();
  }

  public sendPasswordReset(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    this.keep({ purpose: 'password_reset', ...input });
    return Promise.resolve();
  }

  public sendEmailChangeConfirmation(input: {
    recipient: string;
    displayName: string;
    newEmail: string;
    url: string;
  }): Promise<void> {
    this.keep({ purpose: 'email_change_confirmation', ...input });
    return Promise.resolve();
  }

  public readForTesting(
    recipient?: string,
  ): readonly LocalAuthenticationMailMessage[] {
    return Object.freeze(
      this.messages.filter(
        (message) => recipient === undefined || message.recipient === recipient,
      ),
    );
  }

  private keep(input: Omit<LocalAuthenticationMailMessage, 'createdAt'>): void {
    const message = Object.freeze({ ...input, createdAt: new Date() });
    this.messages.push(message);
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
    private readonly store: AuthenticationMailEnqueueStore,
    private readonly envelope: Pick<ApplicationSecretEnvelope, 'seal'>,
    private readonly fromEmail: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public sendVerification(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    return this.enqueue(
      'verification',
      input.recipient,
      'Verify your Pertexo email',
      renderAuthenticationMail(
        input.displayName,
        'Verify your email to finish creating your Pertexo account.',
        input.url,
      ),
      60 * 60_000,
    );
  }

  public sendPasswordReset(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    return this.enqueue(
      'password_reset',
      input.recipient,
      'Reset your Pertexo password',
      renderAuthenticationMail(
        input.displayName,
        'Use this time-limited link to reset your Pertexo password.',
        input.url,
      ),
      60 * 60_000,
    );
  }

  public sendEmailChangeConfirmation(input: {
    recipient: string;
    displayName: string;
    newEmail: string;
    url: string;
  }): Promise<void> {
    return this.enqueue(
      'email_change_confirmation',
      input.recipient,
      'Confirm your Pertexo email change',
      renderAuthenticationMail(
        input.displayName,
        `Confirm changing your Pertexo email to ${input.newEmail}.`,
        input.url,
      ),
      60 * 60_000,
    );
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
    return this.prepare(
      input.purpose,
      input.recipient,
      input.purpose === 'verification'
        ? 'Verify your Pertexo email'
        : 'Confirm your Pertexo email change',
      renderAuthenticationMail(input.displayName, instruction, input.url),
      input.expiresAt.getTime() - this.now().getTime(),
    );
  }

  private enqueue(
    purpose: 'verification' | 'password_reset' | 'email_change_confirmation',
    recipient: string,
    subject: string,
    text: string,
    validityMillis: number,
  ): Promise<void> {
    return this.store.enqueue(
      this.prepare(purpose, recipient, subject, text, validityMillis),
    );
  }

  private prepare(
    purpose: 'verification' | 'password_reset' | 'email_change_confirmation',
    recipient: string,
    subject: string,
    text: string,
    validityMillis: number,
  ): PreparedAuthenticationProofMail {
    const id = randomUUID();
    const expiresAt = new Date(this.now().getTime() + validityMillis);
    const associatedData = authenticationMailAssociatedData(
      purpose,
      id,
      expiresAt,
    );
    const sealedPayload = this.envelope.seal(
      JSON.stringify({
        fromEmail: this.fromEmail,
        toEmail: recipient,
        subject,
        text,
      }),
      associatedData,
    );
    return { id, purpose, expiresAt, sealedPayload };
  }
}

export function authenticationMailAssociatedData(
  purpose: string,
  id: string,
  expiresAt: Date,
): string {
  return `pertexo/authentication-mail/${purpose}/${id}/${expiresAt.toISOString()}`;
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
