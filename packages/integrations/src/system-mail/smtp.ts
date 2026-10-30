import { createHash } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import SMTPConnection from 'nodemailer/lib/smtp-connection/index.js';
import type {
  SystemMailClient,
  SystemMailConfig,
  SystemMailMessage,
  SystemMailResult,
} from './contracts.js';

export function createSmtpClient(
  config: Extract<SystemMailConfig, { mode: 'smtp' }>,
): SystemMailClient {
  return Object.freeze({
    deduplicates: false,
    sendNotification: (message) => send(config, message),
  });
}

async function send(
  config: Extract<SystemMailConfig, { mode: 'smtp' }>,
  message: SystemMailMessage,
): Promise<SystemMailResult> {
  if (message.signal?.aborted) return { kind: 'retryable' };
  const reference = `<${createHash('sha256').update(message.idempotencyKey).digest('hex')}@${message.fromEmail.slice(message.fromEmail.lastIndexOf('@') + 1)}>`;
  const bytes = await new MailComposer({
    from: { address: message.fromEmail, name: '' },
    to: { address: message.toEmail, name: '' },
    subject: message.subject,
    text: message.text,
    messageId: reference,
    ...(message.unsubscribeUrl === undefined
      ? {}
      : {
          headers: {
            'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }),
    disableFileAccess: true,
    disableUrlAccess: true,
  })
    .compile()
    .build();
  const connection = new SMTPConnection({
    host: config.host,
    port: config.port,
    secure: config.tls === 'implicit',
    requireTLS: config.tls === 'starttls',
    ignoreTLS: config.tls === 'none',
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: message.timeoutMillis,
    greetingTimeout: message.timeoutMillis,
    socketTimeout: message.timeoutMillis,
    dnsTimeout: message.timeoutMillis,
    logger: false,
    debug: false,
  });
  let dispatching = false;
  try {
    return await new Promise<SystemMailResult>((resolve) => {
      let finished = false;
      const isFinished = () => finished;
      const finish = (result: SystemMailResult) => {
        if (isFinished()) return;
        finished = true;
        clearTimeout(deadline);
        message.signal?.removeEventListener('abort', aborted);
        connection.close();
        resolve(result);
      };
      const failure = (error?: SMTPConnection.SMTPError) => {
        const code = error?.responseCode;
        if (code !== undefined && code >= 500 && code < 600)
          finish({ kind: 'failed' });
        else if (code !== undefined && code >= 400 && code < 500)
          finish({ kind: 'retryable' });
        else finish({ kind: dispatching ? 'unknown' : 'retryable' });
      };
      const aborted = () => {
        failure();
      };
      const deadline = setTimeout(aborted, message.timeoutMillis);
      message.signal?.addEventListener('abort', aborted, { once: true });
      connection.on('error', failure);
      connection.on('end', () => {
        failure();
      });
      const dispatch = async () => {
        try {
          if (isFinished()) return;
          await message.beforeDispatch();
          if (isFinished()) return;
          dispatching = true;
          connection.send(
            { from: message.fromEmail, to: [message.toEmail] },
            bytes,
            (error) => {
              if (error) failure(error);
              else finish({ kind: 'submitted', reference });
            },
          );
        } catch {
          // A failed durable mark must not start a network side effect.
          finish({ kind: dispatching ? 'unknown' : 'retryable' });
        }
      };
      connection.connect(() => {
        if (isFinished()) return;
        if (config.auth === undefined) void dispatch();
        else
          // Nodemailer writes onto what it's given, and the parsed settings are frozen.
          connection.login({ ...config.auth }, (error) => {
            if (error) failure(error);
            else void dispatch();
          });
      });
      if (message.signal?.aborted) aborted();
    });
  } finally {
    bytes.fill(0);
  }
}
