import { isIP } from 'node:net';
import { z } from 'zod';
import type { SystemMailConfig } from './system-mail.js';

export class SystemMailConfigurationError extends Error {
  public override readonly name = 'SystemMailConfigurationError';
  public constructor(
    public readonly setting: string,
    public readonly reason:
      | 'api_key_required'
      | 'mail_transport_required'
      | 'smtp_hostname_required'
      | 'smtp_port_required'
      | 'smtp_tls_required'
      | 'smtp_credentials_required',
  ) {
    super('System mail configuration is invalid');
  }
}

const hostname = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      isIP(value) !== 0 ||
      value
        .split('.')
        .every((label) =>
          /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(label),
        ),
  );
const smtp = z.object({
  SYSTEM_MAIL_SMTP_HOST: hostname,
  SYSTEM_MAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SYSTEM_MAIL_SMTP_TLS: z.enum(['starttls', 'implicit', 'none']),
  SYSTEM_MAIL_SMTP_USER: z.string().min(1).max(1024).optional(),
  SYSTEM_MAIL_SMTP_PASSWORD: z.string().min(1).max(4096).optional(),
});

const smtpRemedies: Readonly<
  Record<string, SystemMailConfigurationError['reason']>
> = {
  SYSTEM_MAIL_SMTP_HOST: 'smtp_hostname_required',
  SYSTEM_MAIL_SMTP_PORT: 'smtp_port_required',
  SYSTEM_MAIL_SMTP_TLS: 'smtp_tls_required',
  SYSTEM_MAIL_SMTP_USER: 'smtp_credentials_required',
  SYSTEM_MAIL_SMTP_PASSWORD: 'smtp_credentials_required',
};

export function parseSystemMailConfig(
  environment: Readonly<Record<string, string | undefined>>,
  {
    apiKeyName,
    deployed,
  }: Readonly<{
    apiKeyName: 'AUTH_MAIL_EMAIL_API_KEY' | 'INVITATION_EMAIL_API_KEY';
    deployed: boolean;
  }>,
): SystemMailConfig {
  const mode = environment.SYSTEM_MAIL_TRANSPORT ?? 'resend';
  if (mode === 'resend') {
    const apiKey = environment[apiKeyName];
    if (apiKey === undefined || apiKey.length === 0 || apiKey.length > 512)
      throw new SystemMailConfigurationError(apiKeyName, 'api_key_required');
    return Object.freeze({ mode, apiKey });
  }
  if (mode !== 'smtp')
    throw new SystemMailConfigurationError(
      'SYSTEM_MAIL_TRANSPORT',
      'mail_transport_required',
    );
  const tls = environment.SYSTEM_MAIL_SMTP_TLS ?? 'starttls';
  const parsed = smtp.safeParse({
    SYSTEM_MAIL_SMTP_HOST: environment.SYSTEM_MAIL_SMTP_HOST,
    SYSTEM_MAIL_SMTP_PORT:
      environment.SYSTEM_MAIL_SMTP_PORT ?? (tls === 'implicit' ? '465' : '587'),
    SYSTEM_MAIL_SMTP_TLS: tls,
    SYSTEM_MAIL_SMTP_USER: environment.SYSTEM_MAIL_SMTP_USER,
    SYSTEM_MAIL_SMTP_PASSWORD: environment.SYSTEM_MAIL_SMTP_PASSWORD,
  });
  if (!parsed.success) {
    const setting = String(parsed.error.issues[0]?.path[0]);
    const reason = smtpRemedies[setting] ?? 'smtp_credentials_required';
    throw new SystemMailConfigurationError(setting, reason);
  }
  const value = parsed.data;
  if (
    (value.SYSTEM_MAIL_SMTP_USER === undefined) !==
    (value.SYSTEM_MAIL_SMTP_PASSWORD === undefined)
  )
    throw new SystemMailConfigurationError(
      value.SYSTEM_MAIL_SMTP_USER === undefined
        ? 'SYSTEM_MAIL_SMTP_USER'
        : 'SYSTEM_MAIL_SMTP_PASSWORD',
      'smtp_credentials_required',
    );
  if (
    value.SYSTEM_MAIL_SMTP_TLS === 'none' &&
    (deployed ||
      !['localhost', '127.0.0.1', '::1'].includes(value.SYSTEM_MAIL_SMTP_HOST))
  )
    throw new SystemMailConfigurationError(
      'SYSTEM_MAIL_SMTP_TLS',
      'smtp_tls_required',
    );
  return Object.freeze({
    mode,
    host: value.SYSTEM_MAIL_SMTP_HOST,
    port: value.SYSTEM_MAIL_SMTP_PORT,
    tls: value.SYSTEM_MAIL_SMTP_TLS,
    ...(value.SYSTEM_MAIL_SMTP_USER === undefined ||
    value.SYSTEM_MAIL_SMTP_PASSWORD === undefined
      ? {}
      : {
          auth: Object.freeze({
            user: value.SYSTEM_MAIL_SMTP_USER,
            pass: value.SYSTEM_MAIL_SMTP_PASSWORD,
          }),
        }),
  });
}
