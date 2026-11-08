import { smtpCredentialSchema } from '@pertexo/contracts';

export type SmtpField =
  | 'host'
  | 'port'
  | 'security'
  | 'username'
  | 'password'
  | 'fromEmail'
  | 'fromName';
export type SmtpDraft = Readonly<{
  provider: 'smtp';
  host: string;
  port: string;
  security: 'implicit' | 'starttls' | 'none';
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
}>;
export const SMTP_FIELDS: readonly SmtpField[] = [
  'host',
  'port',
  'security',
  'username',
  'password',
  'fromEmail',
  'fromName',
];
export function smtpCredential(draft: SmtpDraft) {
  return {
    type: 'smtp' as const,
    host: draft.host.trim(),
    port: Number(draft.port),
    security: draft.security,
    username: draft.username,
    password: draft.password,
    fromEmail: draft.fromEmail.trim(),
    ...(draft.fromName.trim() === ''
      ? {}
      : { fromName: draft.fromName.trim() }),
  };
}
export function smtpDraftErrors(
  draft: SmtpDraft,
): Partial<Record<SmtpField, string>> {
  const parsed = smtpCredentialSchema.safeParse(smtpCredential(draft));
  if (parsed.success) return {};
  const errors: Partial<Record<SmtpField, string>> = {};
  const messages: Record<SmtpField, string> = {
    host: 'Enter the SMTP hostname or IP address, without a URL or spaces.',
    port: 'Use a port from 1 to 65535.',
    security: 'Choose how this connection uses TLS.',
    username: 'Enter the SMTP username.',
    password: 'Enter the SMTP password.',
    fromEmail: 'Enter a valid sender email address.',
    fromName:
      'Use a sender name of at most 128 characters without line breaks.',
  };
  for (const issue of parsed.error.issues) {
    const field = SMTP_FIELDS.find((field) => field === issue.path[0]);
    if (field !== undefined) errors[field] = messages[field];
  }
  return errors;
}

export function emptySmtpDraft(): SmtpDraft {
  return {
    provider: 'smtp',
    host: '',
    port: '587',
    security: 'starttls',
    username: '',
    password: '',
    fromEmail: '',
    fromName: '',
  };
}
