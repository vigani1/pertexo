import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createApplicationSecretEnvelope,
  createSystemMailDeliveryHandler,
  createSystemMailDeliveryStore,
  createSystemMailEnqueueStore,
  authenticationMailAssociatedData,
  type SystemMailFailure,
  type SystemMailClient,
} from '@pertexo/secrets/server';
import { createSystemMailClient } from '../../src/mail/system-mail-client.js';
import {
  adminUrl,
  apiBaseUrl,
  databaseUrl,
  storeConfig,
  prepareDeliveryIntegrationTestTsFixture,
  closeDeliveryIntegrationTestTsFixture,
} from './system-mail-delivery.fixture.js';

let admin: Pool;
let store: ReturnType<typeof createSystemMailDeliveryStore>;
let enqueue: ReturnType<typeof createSystemMailEnqueueStore>;
const envelope = createApplicationSecretEnvelope({
  current: { version: 'v1', key: Buffer.alloc(32, 1).toString('base64') },
});
const canary = 'private-provider-reply-with-password-and-link';
beforeAll(async () => {
  await prepareDeliveryIntegrationTestTsFixture();
  admin = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
  store = createSystemMailDeliveryStore(storeConfig(databaseUrl(apiBaseUrl)));
  enqueue = createSystemMailEnqueueStore(storeConfig(databaseUrl(apiBaseUrl)));
});
afterAll(async () => {
  await Promise.all([admin.end(), store.close(), enqueue.close()]);
  await closeDeliveryIntegrationTestTsFixture();
});

async function expectDeliveryFailure(
  email: SystemMailClient,
  failure: SystemMailFailure,
  guidance: RegExp,
  expectedStatus: 'failed' | 'retry',
) {
  const id = randomUUID(),
    expiresAt = new Date(Date.now() + 3_600_000);
  await enqueue.enqueue({
    id,
    purpose: 'password_reset',
    expiresAt,
    sealedPayload: envelope.seal(
      JSON.stringify({
        fromEmail: 'from@example.test',
        toEmail: 'to@example.test',
        subject: 'Private subject',
        text: `https://app.example.test/reset/${canary}`,
      }),
      authenticationMailAssociatedData('password_reset', id, expiresAt),
    ),
  });
  const diagnostics: unknown[] = [];
  const handler = createSystemMailDeliveryHandler({
    store,
    envelope,
    email,
    timeoutMillis: 1_000,
    workerId: 'mail-diagnostics',
    onFailure: (detail) => {
      diagnostics.push(detail);
    },
  });
  await handler.runOnce();
  const row = (
    await admin.query<{ status: string; failure_code: string }>(
      'select status,failure_code from app.system_mail_deliveries where id=$1',
      [id],
    )
  ).rows[0];
  expect(row?.failure_code).toBe(
    `delivery.${failure.category}${failure.status === undefined ? '' : `.${String(failure.status)}`}`,
  );
  expect(row?.status).toBe(expectedStatus);
  expect(diagnostics).toEqual([expect.objectContaining(failure)]);
  const safe = JSON.stringify(diagnostics);
  expect(safe).toMatch(guidance);
  expect(safe).not.toMatch(
    new RegExp(
      `${canary}|Private subject|https://|smtp-password|api-key-canary`,
      'u',
    ),
  );
  // Keep a temporary retry from being picked up by the next scenario.
  await admin.query('delete from app.system_mail_deliveries where id=$1', [id]);
}

it.each([
  ['authentication', 535, /credentials/u, 'failed'],
  ['sender_rejected', 550, /sender/u, 'failed'],
  ['recipient_rejected', 550, /recipient/u, 'failed'],
  ['recipient_rejected', 450, /recipient/u, 'retry'],
] as const)(
  'stores safe SMTP %s/%s diagnosis and repair guidance',
  async (category, status, guidance, expectedStatus) => {
    const reject = Object.assign(new Error(canary), { responseCode: status });
    const options: SMTPServerOptions = {
      logger: false,
      authOptional: category !== 'authentication',
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
    };
    if (category === 'authentication')
      options.onAuth = (_auth, _session, callback) => {
        callback(reject);
      };
    if (category === 'sender_rejected')
      options.onMailFrom = (_address, _session, callback) => {
        callback(reject);
      };
    if (category === 'recipient_rejected')
      options.onRcptTo = (_address, _session, callback) => {
        callback(reject);
      };
    const relay = new SMTPServer(options);
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Relay missing');
    try {
      await expectDeliveryFailure(
        createSystemMailClient({
          mode: 'smtp',
          host: '127.0.0.1',
          port: address.port,
          tls: 'none',
          ...(category === 'authentication'
            ? { auth: { user: 'smtp-user', pass: 'smtp-password' } }
            : {}),
        }),
        { category, status },
        guidance,
        expectedStatus,
      );
    } finally {
      await new Promise<void>((resolve) => {
        relay.close(() => {
          resolve();
        });
      });
    }
  },
);

it.each([
  {
    status: 401,
    name: 'invalid_api_key',
    category: 'authentication',
    guidance: /credentials/u,
    expectedStatus: 'failed',
  },
  {
    status: 403,
    name: 'domain_not_verified',
    category: 'sender_rejected',
    guidance: /sender/u,
    expectedStatus: 'failed',
  },
  {
    status: 429,
    name: 'rate_limit_exceeded',
    category: 'rate_limited',
    guidance: /limiting/u,
    expectedStatus: 'retry',
  },
  {
    status: 503,
    name: 'service_unavailable',
    category: 'provider_unavailable',
    guidance: /unavailable/u,
    expectedStatus: 'retry',
  },
  {
    status: 400,
    name: 'validation_error',
    category: 'provider_rejected',
    guidance: /sending policy/u,
    expectedStatus: 'failed',
  },
] as const)(
  'stores safe Resend $status/$name diagnosis and repair guidance',
  async ({ status, name, category, guidance, expectedStatus }) => {
    const email = createSystemMailClient(
      { mode: 'resend', apiKey: 'api-key-canary' },
      {
        execute: async (request) => {
          await request.beforeDispatch();
          return {
            status,
            headers: {},
            body: Buffer.from(JSON.stringify({ name, message: canary })),
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          };
        },
      },
    );
    await expectDeliveryFailure(
      email,
      { category, status },
      guidance,
      expectedStatus,
    );
  },
);

it('retains a safe TLS diagnosis for an untrusted SMTP certificate', async () => {
  const relay = new SMTPServer({
    secure: true,
    authOptional: true,
    logger: false,
    key: readFileSync(
      new URL(
        '../../../../packages/secrets/test/mail/localhost.key',
        import.meta.url,
      ),
    ),
    cert: readFileSync(
      new URL(
        '../../../../packages/secrets/test/mail/localhost.crt',
        import.meta.url,
      ),
    ),
  });
  relay.on('error', () => undefined);
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Relay missing');
  try {
    await expectDeliveryFailure(
      createSystemMailClient({
        mode: 'smtp',
        host: '127.0.0.1',
        port: address.port,
        tls: 'implicit',
      }),
      { category: 'tls' },
      /TLS/u,
      'retry',
    );
  } finally {
    await new Promise<void>((resolve) => {
      relay.close(() => {
        resolve();
      });
    });
  }
});

it.each(['starttls', 'network'] as const)(
  'retains safe SMTP %s failure and retry state',
  async (failure) => {
    const relay = createServer((socket) => {
      if (failure === 'network') {
        socket.destroy();
        return;
      }
      socket.write('220 relay.example.test ESMTP\r\n');
      let input = '';
      socket.on('data', (bytes) => {
        input += bytes.toString('utf8');
        let boundary: number;
        while ((boundary = input.indexOf('\r\n')) !== -1) {
          const line = input.slice(0, boundary);
          input = input.slice(boundary + 2);
          if (line.startsWith('EHLO'))
            socket.write('250-relay.example.test\r\n250 STARTTLS\r\n');
          else if (line === 'STARTTLS') socket.write(`454 ${canary}\r\n`);
        }
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.address();
    if (address === null || typeof address === 'string')
      throw new Error('Relay missing');
    try {
      await expectDeliveryFailure(
        createSystemMailClient({
          mode: 'smtp',
          host: '127.0.0.1',
          port: address.port,
          tls: failure === 'starttls' ? 'starttls' : 'none',
        }),
        failure === 'starttls'
          ? { category: 'tls', status: 454 }
          : { category: 'network' },
        failure === 'starttls' ? /TLS/u : /network/u,
        'retry',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        relay.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  },
);
