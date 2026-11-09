import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import type { NodeVerifiedByteSource } from '@pertexo/node-sdk/server';
import type { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  assertPublicAddress,
  isAllowedPrivateAddress,
  type AllowedPrivateNetwork,
} from '../outbound-http/transport/address-policy.js';
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

type SmtpConfig = Extract<SystemMailConfig, { mode: 'smtp' }>;
type SmtpCheck = Readonly<{ timeoutMillis: number; signal?: AbortSignal }>;
export type SmtpOutboundPolicy = Readonly<{
  allowedPrivateNetworks: readonly AllowedPrivateNetwork[];
  allowPlaintext: boolean;
}>;
type SmtpClient = SystemMailClient &
  Readonly<{ verify(input: SmtpCheck): Promise<SystemMailResult> }>;

export function createSmtpClient(
  config: SmtpConfig,
  policy?: SmtpOutboundPolicy,
): SmtpClient {
  return Object.freeze({
    deduplicates: false,
    sendNotification: (message) => send(config, message, policy),
    verify: (input) => session(config, input, undefined, policy),
  });
}

async function send(
  config: Extract<SystemMailConfig, { mode: 'smtp' }>,
  message: SystemMailMessage,
  policy: SmtpOutboundPolicy | undefined,
): Promise<SystemMailResult> {
  const reference = `<${createHash('sha256').update(message.idempotencyKey).digest('hex')}@${message.fromEmail.slice(message.fromEmail.lastIndexOf('@') + 1)}>`;
  const composer = new MailComposer({
    from: { address: message.fromEmail, name: message.fromName ?? '' },
    to: { address: message.toEmail, name: '' },
    subject: message.subject,
    text: message.text,
    attachments:
      message.mime === undefined ? undefined : [...message.mime.attachments],
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
  }).compile();
  let bytes: Buffer | Readable | undefined;
  let spooled: NodeVerifiedByteSource | undefined;
  try {
    if (message.mime === undefined) bytes = await composer.build();
    else {
      const stream = composer.createReadStream();
      spooled = await message.mime.spool({
        body: stream,
        cancelSource: (error) => {
          stream.destroy(error);
        },
        maxBytes: FILE_PAGE_LIMITS.fileBytes,
        signal: message.signal ?? new AbortController().signal,
      });
      bytes = spooled.open(message.signal ?? new AbortController().signal);
    }
    return await session(
      config,
      message,
      { message, bytes, reference },
      policy,
    );
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    else bytes?.destroy();
    await spooled?.release();
  }
}

async function session(
  config: SmtpConfig,
  input: SmtpCheck,
  content:
    | Readonly<{
        message: SystemMailMessage;
        bytes: Buffer | Readable;
        reference: string;
      }>
    | undefined,
  policy: SmtpOutboundPolicy | undefined,
): Promise<SystemMailResult> {
  if (input.signal?.aborted)
    return { kind: 'retryable', failure: { category: 'cancelled' } };
  const started = performance.now();
  let host = config.host;
  if (policy !== undefined) {
    if (config.tls === 'none' && !policy.allowPlaintext)
      return { kind: 'failed', failure: { category: 'tls' } };
    try {
      const answers = await resolveHost(config.host, input);
      for (const answer of answers) {
        if (
          !isAllowedPrivateAddress(
            answer.address,
            policy.allowedPrivateNetworks,
          )
        )
          assertPublicAddress(answer.address);
      }
      const address = answers[0];
      if (address === undefined) throw new Error('No address');
      host = address.address;
    } catch {
      return { kind: 'failed', failure: { category: 'network' } };
    }
  }
  const remainingMillis = Math.max(
    1,
    input.timeoutMillis - (performance.now() - started),
  );
  if (input.signal?.aborted)
    return { kind: 'retryable', failure: { category: 'cancelled' } };
  const connection = new SMTPConnection({
    host,
    servername: isIP(config.host) ? undefined : config.host,
    port: config.port,
    secure: config.tls === 'implicit',
    requireTLS: config.tls === 'starttls',
    ignoreTLS: config.tls === 'none',
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: input.timeoutMillis,
    greetingTimeout: input.timeoutMillis,
    socketTimeout: input.timeoutMillis,
    dnsTimeout: input.timeoutMillis,
    logger: false,
    debug: false,
  });
  let dispatching = false;
  return await new Promise<SystemMailResult>((resolve) => {
    let finished = false;
    const isFinished = () => finished;
    const finish = (result: SystemMailResult) => {
      if (isFinished()) return;
      finished = true;
      clearTimeout(deadline);
      input.signal?.removeEventListener('abort', aborted);
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
    }, remainingMillis);
    input.signal?.addEventListener('abort', aborted, { once: true });
    connection.on('error', failure);
    connection.on('end', () => {
      failure();
    });
    const dispatch = async () => {
      try {
        if (isFinished()) return;
        if (content === undefined) {
          connection.quit();
          finish({ kind: 'submitted', reference: '' });
          return;
        }
        const { message, bytes, reference } = content;
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
    if (input.signal?.aborted) aborted();
  });
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

async function resolveHost(host: string, input: SmtpCheck) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      lookup(host, { all: true, order: 'verbatim' }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('SMTP DNS deadline'));
        }, input.timeoutMillis);
        aborted = () => {
          reject(new Error('SMTP cancelled'));
        };
        input.signal?.addEventListener('abort', aborted, { once: true });
        if (input.signal?.aborted) aborted();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (aborted !== undefined)
      input.signal?.removeEventListener('abort', aborted);
  }
}
