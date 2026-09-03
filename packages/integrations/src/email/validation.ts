import { z } from 'zod';

const MAX_SUBJECT_BYTES = 1_024;
const MAX_TEXT_BYTES = 262_144;
const UNSAFE_MAILBOX_CHARACTERS = [
  '(',
  ')',
  ',',
  ':',
  ';',
  '<',
  '>',
  '[',
  ']',
  '"',
  '\\',
] as const;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const localPart =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u;
const domainLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

export const providerEmailMailboxSchema = z
  .string()
  .min(3)
  .max(254)
  .refine((value) => /^[\x21-\x7e]+$/u.test(value))
  .refine((value) => {
    if (
      UNSAFE_MAILBOX_CHARACTERS.some((character) => value.includes(character))
    )
      return false;
    const at = value.indexOf('@');
    if (at < 1 || at !== value.lastIndexOf('@')) return false;
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (local.length > 64 || domain.length > 253 || !localPart.test(local))
      return false;
    const labels = domain.split('.');
    return (
      labels.length >= 2 && labels.every((label) => domainLabel.test(label))
    );
  })
  .overwrite((value) => {
    const at = value.indexOf('@');
    return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
  });

export const emailSendNotificationConfigSchema = z
  .object({ timeoutMillis: z.number().int().min(1).max(30_000) })
  .strict()
  .readonly();

export const emailSendNotificationInputSchema = z
  .object({
    toEmail: providerEmailMailboxSchema,
    subject: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n\0]/u.test(value))
      .refine((value) => utf8Bytes(value) <= MAX_SUBJECT_BYTES),
    text: z
      .string()
      .min(1)
      .max(50_000)
      .refine((value) => utf8Bytes(value) <= MAX_TEXT_BYTES),
  })
  .strict()
  .readonly();

export const emailSendNotificationOutputSchema = z
  .object({ emailId: z.uuid() })
  .strict()
  .readonly();

export const resolvedResendApiKeyCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('resend_api_key'),
    apiKey: z
      .string()
      .min(8)
      .max(512)
      .regex(/^re_[A-Za-z0-9_-]+$/u),
    fromEmail: providerEmailMailboxSchema,
  })
  .strict()
  .readonly();

export type EmailSendNotificationOutput = z.output<
  typeof emailSendNotificationOutputSchema
>;

export const EMAIL_SEND_NOTIFICATION_LIMITS = Object.freeze({
  maxResponseBytes: 65_536,
  maxRetryAfterMillis: 300_000,
  maxSubjectBytes: MAX_SUBJECT_BYTES,
  maxTextBytes: MAX_TEXT_BYTES,
});
