import { emailMailboxSchema } from '@pertexo/contracts';
import { nodeArtifactReferenceSchema } from '@pertexo/node-sdk';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';
import { PROVIDER_STEP_TIMEOUT } from '../../providers/provider-timeout.js';

const MAX_SUBJECT_BYTES = 1_024;
const MAX_TEXT_BYTES = 262_144;
const MAX_ATTACHMENTS = 10;
// Base64 of every attachment must leave room for the rest of the message
// inside the 10 MiB file-backed request body ceiling (ADR 075).
const MAX_ATTACHMENT_ENCODED_BYTES = 8_388_608;
const MAX_FILENAME_BYTES = 255;
const EMAIL_FIELD_LIMITS = Object.freeze({
  // A given filename is cut down to MAX_FILENAME_BYTES when sent.
  givenFilenameCharacters: 1_024,
  subjectCharacters: 200,
  textCharacters: 50_000,
  minimumApiKeyCharacters: 8,
  apiKeyCharacters: 512,
  responseBytes: 65_536,
});
// Base64 writes 4 characters for every 3 bytes.
const BASE64_GROUP = Object.freeze({ bytes: 3, characters: 4 });
export const emailSendNotificationConfigSchema = z
  .object({
    timeoutMillis: z
      .number()
      .int()
      .min(1)
      .max(PROVIDER_STEP_TIMEOUT.maxMillis)
      .meta({ default: PROVIDER_STEP_TIMEOUT.defaultMillis }),
  })
  .strict()
  .readonly();

export const emailAttachmentSchema = z
  .object({
    file: nodeArtifactReferenceSchema
      .unwrap()
      .extend({ kind: z.literal('artifact') })
      .strict(),
    // Sanitized when sent: path separators and control characters are dropped.
    filename: z
      .string()
      .max(EMAIL_FIELD_LIMITS.givenFilenameCharacters)
      .optional(),
  })
  .strict()
  .readonly();

export const emailSendNotificationInputSchema = z
  .object({
    toEmail: emailMailboxSchema,
    subject: z
      .string()
      .min(1)
      .max(EMAIL_FIELD_LIMITS.subjectCharacters)
      .refine((value) => !/[\r\n\0]/u.test(value))
      .refine((value) => utf8ByteLength(value) <= MAX_SUBJECT_BYTES),
    text: z
      .string()
      .min(1)
      .max(EMAIL_FIELD_LIMITS.textCharacters)
      .refine((value) => utf8ByteLength(value) <= MAX_TEXT_BYTES),
    // Counted and measured by the executor, so too many or too large fails
    // with its own problem instead of a generic input error.
    attachments: z.array(emailAttachmentSchema).readonly().optional(),
  })
  .strict()
  .readonly();

export const emailSentAttachmentSchema = z
  .object({
    filename: z.string().min(1).max(MAX_FILENAME_BYTES),
    mediaType: nodeArtifactReferenceSchema.unwrap().shape.mediaType,
    byteLength: nodeArtifactReferenceSchema.unwrap().shape.byteLength,
  })
  .strict()
  .readonly();

export const emailSendNotificationOutputSchema = z
  .object({
    emailId: z.uuid(),
    // Names and sizes only; the files themselves stay where they are.
    attachments: z
      .array(emailSentAttachmentSchema)
      .min(1)
      .max(MAX_ATTACHMENTS)
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();

export const resolvedResendApiKeyCredentialSchema = z
  .object({
    type: z.literal('resend_api_key'),
    apiKey: z
      .string()
      .min(EMAIL_FIELD_LIMITS.minimumApiKeyCharacters)
      .max(EMAIL_FIELD_LIMITS.apiKeyCharacters)
      .regex(/^re_[A-Za-z0-9_-]+$/u),
    fromEmail: emailMailboxSchema,
  })
  .strict()
  .readonly();

export type EmailAttachment = z.output<typeof emailAttachmentSchema>;
export type EmailSentAttachment = z.output<typeof emailSentAttachmentSchema>;
export type EmailSendNotificationConfig = z.output<
  typeof emailSendNotificationConfigSchema
>;
export type EmailSendNotificationInput = z.output<
  typeof emailSendNotificationInputSchema
>;
export type EmailSendNotificationOutput = z.output<
  typeof emailSendNotificationOutputSchema
>;

/** An attachment's size once base64-encoded, as Resend measures the total. */
export function encodedAttachmentBytes(byteLength: number): number {
  return Math.ceil(byteLength / BASE64_GROUP.bytes) * BASE64_GROUP.characters;
}

export const EMAIL_SEND_NOTIFICATION_LIMITS = Object.freeze({
  maxResponseBytes: EMAIL_FIELD_LIMITS.responseBytes,
  maxSubjectBytes: MAX_SUBJECT_BYTES,
  maxTextBytes: MAX_TEXT_BYTES,
  maxAttachments: MAX_ATTACHMENTS,
  maxAttachmentEncodedBytes: MAX_ATTACHMENT_ENCODED_BYTES,
  // Base64 writes 4 characters for every 3 bytes of the files themselves.
  maxAttachmentBytes: (MAX_ATTACHMENT_ENCODED_BYTES / 4) * 3,
  maxAttachmentFilenameBytes: MAX_FILENAME_BYTES,
});
