import { SMTPServer } from 'smtp-server';
import { z } from 'zod';
import {
  createWorkspaceInboxFoldStore,
  createNoticeMailStore,
} from '@pertexo/core/inbox';
import { type DatabaseConfig } from '@pertexo/database/platform';
import { createSystemMailDeliveryStore } from '@pertexo/secrets/server';
import {
  createApplicationSecretEnvelope,
  createSystemMailClient,
} from '@pertexo/integrations/server';
import { RedisWorkspaceInboxHintPublisher } from '@pertexo/queue';
import { createWorkspaceInboxRuntime } from '../../../../src/notifications/inbox-runtime.js';
import { createSystemMailRuntime } from '../../../../src/mail/runtime.js';
import { createSystemMailDeliveryHandler } from '../../../../src/mail/delivery.js';
import { sealNoticeMail } from '../../../../src/mail/notice-content.js';
import type { PollingRuntime } from '../../../../src/runtime/polling.js';
function textBody(raw: string) {
  const split = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, split),
    body = raw.slice(split + 4);
  if (/Content-Transfer-Encoding: base64/iu.test(headers)) {
    return Buffer.from(body, 'base64').toString('utf8');
  }
  if (/Content-Transfer-Encoding: quoted-printable/iu.test(headers)) {
    return body
      .replace(/=\r?\n/gu, '')
      .replace(/=([A-F0-9]{2})/giu, (_match: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
  }
  return body;
}
/** Owns only the existing production inbox/mail runtimes and a loopback SMTP sink. */
export async function createEditorNotifications(
  database: DatabaseConfig,
  maintenance: DatabaseConfig,
  redisUrl: string,
  mail: Readonly<{ key: string; publicWebOrigin: string }> | undefined,
): Promise<PollingRuntime> {
  const inbox = createWorkspaceInboxRuntime(
    createWorkspaceInboxFoldStore(database, undefined, maintenance),
    new RedisWorkspaceInboxHintPublisher({ redisUrl }),
    { foldBatchSize: 100, foldPollMillis: 100 },
    {
      cycleFailed: () => process.stderr.write('Owned inbox cycle failed\n'),
      hintFailed: () => process.stderr.write('Owned inbox hint failed\n'),
    },
  );
  let relay: SMTPServer | undefined;
  let delivery: PollingRuntime | undefined;
  const loose: { close(): Promise<void> }[] = [];
  const close = async () => {
    const results = await Promise.allSettled([
      inbox.close(),
      ...(delivery === undefined
        ? loose.map((resource) => resource.close())
        : [delivery.close()]),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, 'Owned notifications did not drain');
    if (relay?.server.listening === true)
      await new Promise<void>((resolve) => relay?.close(resolve));
  };
  try {
    if (mail !== undefined) {
      const key = z
        .string()
        .regex(/^[A-Za-z0-9+/]{43}=$/u)
        .parse(mail.key);
      const envelope = createApplicationSecretEnvelope({
        current: { version: 'notice-browser-v1', key },
      });
      relay = new SMTPServer({
        logger: false,
        authOptional: true,
        disabledCommands: ['STARTTLS'],
        onData: (stream, _session, callback) => {
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 32768) chunks.push(chunk);
          });
          stream.on('end', () => {
            if (size > 32768) {
              callback(new Error('Owned notice exceeds its envelope'));
              return;
            }
            process.send?.({
              phase: 'notice-mail',
              text: textBody(Buffer.concat(chunks).toString('utf8')),
            });
            callback();
          });
        },
      });
      await new Promise<void>((resolve, reject) => {
        relay?.server.once('error', reject);
        relay?.listen(0, '127.0.0.1', resolve);
      });
      const address = relay.server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Owned SMTP has no address');
      const store = createSystemMailDeliveryStore(database);
      loose.push(store);
      const notices = createNoticeMailStore(database, maintenance, (input) =>
        sealNoticeMail(
          envelope,
          'security@example.test',
          mail.publicWebOrigin,
          input,
        ),
      );
      loose.push(notices);
      delivery = createSystemMailRuntime(
        createSystemMailDeliveryHandler({
          store,
          envelope,
          email: createSystemMailClient({
            mode: 'smtp',
            host: '127.0.0.1',
            port: address.port,
            tls: 'none',
          }),
          notices,
          timeoutMillis: 5000,
          workerId: 'browser-notice-mail',
        }),
        {
          close: async () => {
            await store.close();
            await notices.close();
          },
        },
        100,
        () => process.stderr.write('Owned notice mail cycle failed\n'),
      );
    }
    return {
      start: () => {
        inbox.start();
        delivery?.start();
      },
      checkReadiness: async () => {
        await inbox.checkReadiness();
        await delivery?.checkReadiness();
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Owned notification setup failed',
      );
    }
    throw error;
  }
}
