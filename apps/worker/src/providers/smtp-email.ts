import type { Readable } from 'node:stream';
import type { SmtpEmailClient } from '@pertexo/integrations/server';
import { createSmtpClient } from '@pertexo/secrets/server';

export function createSmtpEmailClient(
  policy: NonNullable<Parameters<typeof createSmtpClient>[1]>,
): SmtpEmailClient {
  return {
    sendNotification: async (credential, message) => {
      const signal = message.signal ?? new AbortController().signal;
      const attachments: {
        filename: string;
        contentType: string;
        content: Readable;
      }[] = [];
      try {
        for (const file of message.attachments?.files ?? []) {
          attachments.push({
            filename: file.filename,
            contentType: file.contentType,
            content: file.source.open(signal),
          });
        }
        return await createSmtpClient(
          {
            mode: 'smtp',
            host: credential.host,
            port: credential.port,
            tls: credential.security,
            auth: { user: credential.username, pass: credential.password },
          },
          policy,
        ).sendNotification({
          fromEmail: credential.fromEmail,
          ...(credential.fromName === undefined
            ? {}
            : { fromName: credential.fromName }),
          toEmail: message.toEmail,
          subject: message.subject,
          text: message.text,
          idempotencyKey: message.idempotencyKey,
          timeoutMillis: message.timeoutMillis,
          signal,
          beforeDispatch: message.beforeDispatch,
          ...(message.attachments === undefined
            ? {}
            : { mime: { attachments, spool: message.attachments.spool } }),
        });
      } finally {
        for (const file of attachments) file.content.destroy();
      }
    },
  };
}
