import {
  NodeExecutorFailure,
  type NodeArtifactReference,
} from '@pertexo/node-sdk/server';
import {
  EMAIL_SEND_NOTIFICATION_LIMITS,
  encodedAttachmentBytes,
  type EmailAttachment,
  type EmailSentAttachment,
} from '../validation.js';
import {
  defaultAttachmentFilename,
  sanitizeAttachmentFilename,
} from './filename.js';

const EMAIL_ATTACHMENT_ERROR_CODES = Object.freeze({
  tooMany: 'email.too_many_attachments',
  tooLarge: 'email.attachments_too_large',
});

const MIB = 1_048_576;
const { maxAttachments, maxAttachmentEncodedBytes } =
  EMAIL_SEND_NOTIFICATION_LIMITS;
const SUMMARIES = {
  tooMany: `An email can carry at most ${String(maxAttachments)} attachments. Attach fewer files or split them across several emails.`,
  tooLarge: `The attachments exceed ${String((maxAttachmentEncodedBytes * 3) / 4 / MIB)} MB together (${String(maxAttachmentEncodedBytes / MIB)} MB once encoded for email). Attach fewer or smaller files, or split them across several emails.`,
} as const;

/** A definite refusal before any file is read or anything is sent. */
export class EmailAttachmentFailure extends NodeExecutorFailure {
  public override readonly name = 'EmailAttachmentFailure';
  constructor(reason: keyof typeof EMAIL_ATTACHMENT_ERROR_CODES) {
    super({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
      safeErrorCode: EMAIL_ATTACHMENT_ERROR_CODES[reason],
      errorSummary: SUMMARIES[reason],
    });
  }
}

export type PlannedAttachment = Readonly<{
  reference: NodeArtifactReference;
  filename: string;
  contentType: string;
}>;

/** Names each file and checks the count and total size from the references alone. */
export function planAttachments(
  attachments: readonly EmailAttachment[],
): readonly PlannedAttachment[] {
  if (attachments.length > maxAttachments)
    throw new EmailAttachmentFailure('tooMany');
  const encoded = attachments.reduce(
    (total, { file }) => total + encodedAttachmentBytes(file.byteLength),
    0,
  );
  if (encoded > maxAttachmentEncodedBytes)
    throw new EmailAttachmentFailure('tooLarge');
  return attachments.map(({ file, filename }, index) => {
    const { kind: _kind, ...reference } = file;
    return Object.freeze({
      reference,
      filename:
        (filename === undefined
          ? undefined
          : sanitizeAttachmentFilename(filename)) ??
        defaultAttachmentFilename(file.mediaType, {
          index,
          count: attachments.length,
        }),
      contentType: file.mediaType,
    });
  });
}

/** The output's record of what was sent: names, types and sizes, never bytes. */
export function sentAttachments(
  planned: readonly PlannedAttachment[],
): Readonly<{ attachments?: readonly EmailSentAttachment[] }> {
  if (planned.length === 0) return {};
  return {
    attachments: planned.map((attachment) => ({
      filename: attachment.filename,
      mediaType: attachment.contentType,
      byteLength: attachment.reference.byteLength,
    })),
  };
}
