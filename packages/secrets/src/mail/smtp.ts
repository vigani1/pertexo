import { createHash } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import SMTPConnection from 'nodemailer/lib/smtp-connection/index.js';
import type {
  SystemMailClient,
  SystemMailConfig,
  SystemMailMessage,
  SystemMailResult,
  SystemMailFailure,
} from './system-mail.js';

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
  if (message.signal?.aborted)
    return { kind: 'retryable', failure: { category: 'cancelled' } };
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
        const detail = smtpFailure(error);
        if (code !== undefined && code >= 500 && code < 600)
          finish({ kind: 'failed', failure: detail });
        else if (code !== undefined && code >= 400 && code < 500)
          finish({ kind: 'retryable', failure: detail });
        else
          finish({
            kind: dispatching ? 'unknown' : 'retryable',
            failure: detail,
          });
      };
      const aborted = () => {
        finish({
          kind: dispatching ? 'unknown' : 'retryable',
          failure: { category: 'cancelled' },
        });
      };
      const deadline = setTimeout(() => {
        failure();
      }, message.timeoutMillis);
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
          finish({
            kind: dispatching ? 'unknown' : 'retryable',
            failure: { category: 'dispatch_refused' },
          });
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

function smtpFailure(
  error: SMTPConnection.SMTPError | undefined,
): SystemMailFailure {
  let category: SystemMailFailure['category'] = 'network';
  if (error?.code === 'EAUTH') category = 'authentication';
  else if (
    error?.command === 'STARTTLS' ||
    error?.code === 'ETLS' ||
    new Set([
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]).has(error?.originalCode ?? '')
  )
    category = 'tls';
  else if (error?.command === 'MAIL FROM') category = 'sender_rejected';
  else if (error?.command === 'RCPT TO') category = 'recipient_rejected';
  else if (error?.responseCode !== undefined) category = 'provider_rejected';
  const status = error?.responseCode;
  return {
    category,
    ...(status !== undefined && status >= 400 && status < 600
      ? { status }
      : {}),
  };
}
