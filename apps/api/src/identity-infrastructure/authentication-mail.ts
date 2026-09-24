import { randomUUID } from 'node:crypto';

import type { AuthenticationMailEnqueueStore } from '@pertexo/database/api';
import type { ApplicationSecretEnvelope } from '@pertexo/integrations/server';

import type {
  AuthenticationMail,
  PreparedAuthenticationProofMail,
} from './better-auth.js';

export type LocalAuthenticationMailMessage = Readonly<{
  purpose: 'verification' | 'password_reset' | 'email_change_confirmation';
  recipient: string;
  displayName: string;
  url: string;
  newEmail?: string;
  createdAt: Date;
}>;

/** Non-persistent development/test sink. It never writes bearer URLs to logs. */
export class LocalAuthenticationMailSink implements AuthenticationMail {
  private readonly messages: LocalAuthenticationMailMessage[] = [];

  public sendVerification(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    this.messages.push(
      Object.freeze({
        purpose: 'verification',
        ...input,
        createdAt: new Date(),
      }),
    );
    return Promise.resolve();
  }

  public sendPasswordReset(input: {
    recipient: string;
    displayName: string;
    url: string;
  }): Promise<void> {
    this.messages.push(
      Object.freeze({
        purpose: 'password_reset',
        ...input,
        createdAt: new Date(),
      }),
    );
    return Promise.resolve();
  }

  public sendEmailChangeConfirmation(input: {
    recipient: string;
    displayName: string;
    newEmail: string;
    url: string;
  }): Promise<void> {
    this.messages.push(
      Object.freeze({
        purpose: 'email_change_confirmation',
        ...input,
        createdAt: new Date(),
      }),
    );
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
}

export const disabledAuthenticationMail: AuthenticationMail = Object.freeze({
  sendVerification: () =>
    Promise.reject(new Error('Authentication mail delivery is not configured')),
  sendPasswordReset: () =>
    Promise.reject(new Error('Authentication mail delivery is not configured')),
  sendEmailChangeConfirmation: () =>
    Promise.reject(new Error('Authentication mail delivery is not configured')),
});

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
  return `pertexo/authentication-mail/v1/${purpose}/${id}/${expiresAt.toISOString()}`;
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
