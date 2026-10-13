import { isIP } from 'node:net';
import { z } from 'zod';
import type { SystemMailConfig } from './contracts.js';

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
  host: hostname,
  port: z.coerce.number().int().min(1).max(65535),
  tls: z.enum(['starttls', 'implicit', 'none']),
  user: z.string().min(1).max(1024).optional(),
  pass: z.string().min(1).max(4096).optional(),
});

export function parseSystemMailConfig(
  environment: Readonly<Record<string, string | undefined>>,
  apiKeyName: 'AUTH_MAIL_EMAIL_API_KEY' | 'INVITATION_EMAIL_API_KEY',
  deployed: boolean,
): SystemMailConfig {
  const mode = environment.SYSTEM_MAIL_TRANSPORT ?? 'resend';
  if (mode === 'resend') {
    const apiKey = environment[apiKeyName];
    if (apiKey === undefined || apiKey.length === 0 || apiKey.length > 512)
      throw new Error(`${apiKeyName} is required for Resend delivery`);
    return Object.freeze({ mode, apiKey });
  }
  if (mode !== 'smtp')
    throw new Error('SYSTEM_MAIL_TRANSPORT must be resend or smtp');
  const tls = environment.SYSTEM_MAIL_SMTP_TLS ?? 'starttls';
  const parsed = smtp.safeParse({
    host: environment.SYSTEM_MAIL_SMTP_HOST,
    port:
      environment.SYSTEM_MAIL_SMTP_PORT ?? (tls === 'implicit' ? '465' : '587'),
    tls,
    user: environment.SYSTEM_MAIL_SMTP_USER,
    pass: environment.SYSTEM_MAIL_SMTP_PASSWORD,
  });
  if (!parsed.success)
    throw new Error('SMTP configuration is incomplete or invalid');
  const value = parsed.data;
  if ((value.user === undefined) !== (value.pass === undefined))
    throw new Error('SMTP username and password must be configured together');
  if (
    value.tls === 'none' &&
    (deployed || !['localhost', '127.0.0.1', '::1'].includes(value.host))
  )
    throw new Error('Plaintext SMTP is allowed only on development loopback');
  return Object.freeze({
    mode,
    host: value.host,
    port: value.port,
    tls: value.tls,
    ...(value.user === undefined || value.pass === undefined
      ? {}
      : { auth: Object.freeze({ user: value.user, pass: value.pass }) }),
  });
}
