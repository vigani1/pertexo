import type { NodeArtifactReference } from '@pertexo/node-sdk/server';
import {
  EMAIL_SEND_NOTIFICATION_LIMITS,
  encodedAttachmentBytes,
  type EmailAttachment,
  type EmailSentAttachment,
} from '../send-notification/send-notification.schemas.js';
import {
  defaultAttachmentFilename,
  sanitizeAttachmentFilename,
} from './filename.js';
import { EmailAttachmentFailure } from './attachment.errors.js';

const { maxAttachments, maxAttachmentEncodedBytes } =
  EMAIL_SEND_NOTIFICATION_LIMITS;

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
