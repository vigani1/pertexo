import type { NodeArtifactRuntime } from '@pertexo/node-sdk/server';
import type { Readable } from 'node:stream';
export type SystemMailConfig =
  | Readonly<{ mode: 'resend'; apiKey: string }>
  | Readonly<{
      mode: 'smtp';
      host: string;
      port: number;
      tls: 'starttls' | 'implicit' | 'none';
      auth?: Readonly<{ user: string; pass: string }>;
    }>;

export type SystemMailMessage = Readonly<{
  fromEmail: string;
  fromName?: string;
  mime?: Readonly<{
    attachments: readonly Readonly<{
      filename: string;
      contentType: string;
      content: Readable;
    }>[];
    spool: NonNullable<NodeArtifactRuntime['spool']>;
  }>;
  toEmail: string;
  subject: string;
  text: string;
  unsubscribeUrl?: string;
  idempotencyKey: string;
  timeoutMillis: number;
  signal?: AbortSignal;
  beforeDispatch(): Promise<void>;
}>;

export type SystemMailResult =
  | Readonly<{ kind: 'submitted'; reference: string }>
  | Readonly<{
      kind: 'retryable' | 'failed' | 'unknown';
      failure: SystemMailFailure;
    }>;

export type SystemMailClient = Readonly<{
  deduplicates: boolean;
  sendNotification(message: SystemMailMessage): Promise<SystemMailResult>;
}>;

export type SystemMailFailureCategory =
  keyof typeof SYSTEM_MAIL_FAILURE_GUIDANCE;
export type SystemMailFailure = Readonly<{
  category: SystemMailFailureCategory;
  status?: number;
}>;

/** Fixed guidance only: provider replies can contain credentials or message content. */
export const SYSTEM_MAIL_FAILURE_GUIDANCE = {
  authentication:
    'Check the mail service credentials and permissions, then request a new message.',
  sender_rejected:
    'Verify the sender address and domain with the mail service, then request a new message.',
  recipient_rejected:
    'Check the recipient address and whether the mail service permits delivery to it.',
  tls: 'Check the SMTP TLS mode, hostname and certificate trust, then request a new message.',
  network:
    'Check the mail service hostname, port and network access, then request a new message.',
  rate_limited:
    'The mail service is limiting requests. Wait for the service to recover.',
  provider_unavailable:
    'The mail service is unavailable. Wait for the service to recover.',
  provider_rejected:
    'Check the mail service sending policy and account configuration before retrying.',
  invalid_response:
    'The mail service returned an unusable answer. Check its health and configuration.',
  cancelled:
    'Delivery was interrupted. Check the worker health before retrying.',
  dispatch_refused:
    'Delivery was not authorized. Check whether the notification is still eligible.',
} as const;

/** The bounded stored diagnostic shared by system mail and invitations. */
export function systemMailFailureCode(failure: SystemMailFailure): string {
  return `delivery.${failure.category}${failure.status === undefined ? '' : `.${String(failure.status)}`}`;
}

export function systemMailFailureInstruction(
  result: Exclude<SystemMailResult, { kind: 'submitted' }>,
): string {
  const guidance = SYSTEM_MAIL_FAILURE_GUIDANCE[result.failure.category];
  if (result.kind === 'unknown')
    return `${guidance} Delivery may have been accepted. Check the mail service before requesting another message.`;
  if (result.kind === 'retryable')
    return `${guidance} Delivery will retry automatically while the message remains valid.`;
  return `${guidance} Repair the setting before requesting another message.`;
}
