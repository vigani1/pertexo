import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { EMAIL_SEND_NOTIFICATION_LIMITS } from '../send-notification/send-notification.schemas.js';

const MIB = 1_048_576;
const { maxAttachments, maxAttachmentEncodedBytes } =
  EMAIL_SEND_NOTIFICATION_LIMITS;

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

export const EMAIL_ATTACHMENT_ERROR_CODES = Object.freeze({
  tooMany: 'email.too_many_attachments',
  tooLarge: 'email.attachments_too_large',
});
const SUMMARIES = {
  tooMany: `An email can carry at most ${String(maxAttachments)} attachments. Attach fewer files or split them across several emails.`,
  tooLarge: `The attachments exceed ${String((maxAttachmentEncodedBytes * 3) / 4 / MIB)} MB together (${String(maxAttachmentEncodedBytes / MIB)} MB once encoded for email). Attach fewer or smaller files, or split them across several emails.`,
} as const;
