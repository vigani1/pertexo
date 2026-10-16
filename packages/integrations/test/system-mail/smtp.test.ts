import { readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import {
  SMTPServer,
  type SMTPServerOptions,
  type SMTPServerAuthentication,
  type SMTPServerSession,
  type SMTPServerAuthenticationResponse,
} from 'smtp-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSystemMailClient } from '../../src/system-mail/client.js';
import { parseSystemMailConfig } from '../../src/system-mail/config.js';
import type {
  SystemMailConfig,
  SystemMailMessage,
} from '../../src/system-mail/contracts.js';

// This key and certificate are public fixtures, trusted only within these tests.
const key = readFileSync(new URL('./localhost.key', import.meta.url));
const cert = readFileSync(new URL('./localhost.crt', import.meta.url));
const trusted = getCACertificates('default');
const owners: SMTPServer[] = [];
afterEach(async () => {
  setDefaultCACertificates(trusted);
  await Promise.all(
    owners.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

async function server(options: SMTPServerOptions = {}) {
  const messages: Buffer[] = [];
  const authenticate = vi.fn(
    (
      auth: SMTPServerAuthentication,
      _session: SMTPServerSession,
      callback: (
        error: Error | null,
        response?: SMTPServerAuthenticationResponse,
      ) => void,
    ) => {
      callback(null, { user: auth.username });
    },
  );
  const relay = new SMTPServer({
    key,
    cert,
    logger: false,
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onAuth: authenticate,
    onData: (stream, _session, callback) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        messages.push(Buffer.concat(chunks));
        callback();
      });
    },
    ...options,
  });
  relay.on('error', (error: Error & { code?: string; report?: boolean }) => {
    if (error.code !== 'SocketError' || error.report !== false) throw error;
  });
  owners.push(relay);
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.server.address();
  if (!address || typeof address === 'string')
    throw new Error('SMTP fixture unavailable');
  const config: Extract<SystemMailConfig, { mode: 'smtp' }> = {
    mode: 'smtp',
    host: '127.0.0.1',
    port: address.port,
    tls: 'none',
  };
  return { config, messages, authenticate };
}
const message = (
  overrides: Partial<SystemMailMessage> = {},
): SystemMailMessage => ({
  fromEmail: 'security@example.test',
  toEmail: 'ada@example.test',
  subject: 'Vérifiez votre compte',
  text: 'One immutable link — café',
  idempotencyKey: 'authentication-mail:one',
  timeoutMillis: 2000,
  beforeDispatch: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('real SMTP system mail sessions', () => {
  it('submits a single-recipient MIME message with a stable correlation reference', async () => {
    const fixture = await server();
    const input = message();
    const client = createSystemMailClient(fixture.config);
    const result = await client.sendNotification(input);
    expect(result.kind).toBe('submitted');
    expect(client.deduplicates).toBe(false);
    expect(input.beforeDispatch).toHaveBeenCalledOnce();
    expect(fixture.messages).toHaveLength(1);
    const mime = fixture.messages[0]?.toString();
    expect(mime).toContain('To: ada@example.test');
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8');
    expect(mime).toContain('Subject: =?UTF-8?');
    expect(mime).not.toContain('List-Unsubscribe');
    const second = await client.sendNotification(input);
    expect(second).toEqual(result);
  });
  it('writes both standard one-click headers through MIME composition', async () => {
    const fixture = await server();
    const unsubscribeUrl =
      'https://app.example.test/v1/notifications/unsubscribe/one-click?token=' +
      'a'.repeat(877);
    expect(
      (
        await createSystemMailClient(fixture.config).sendNotification(
          message({ unsubscribeUrl }),
        )
      ).kind,
    ).toBe('submitted');
    const raw = fixture.messages[0]?.toString() ?? '';
    const unfolded = raw.replace(/\r\n[ \t]+/gu, ' ');
    expect(unfolded).toContain(`List-Unsubscribe: <${unsubscribeUrl}>`);
    expect(unfolded).toContain(
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    );
  });
  it.each(['starttls', 'implicit'] as const)(
    'uses authenticated verified %s TLS',
    async (mode) => {
      setDefaultCACertificates([...trusted, cert.toString()]);
      const fixture = await server({
        secure: mode === 'implicit',
        disabledCommands: [],
        authOptional: false,
      });
      const input = message();
      const result = await createSystemMailClient({
        ...fixture.config,
        tls: mode,
        auth: { user: 'smtp-user', pass: 'smtp-password' },
      }).sendNotification(input);
      expect(result.kind).toBe('submitted');
      expect(fixture.authenticate).toHaveBeenCalledOnce();
      expect(fixture.messages).toHaveLength(1);
    },
  );
  it('refuses a relay without STARTTLS and never dispatches', async () => {
    const fixture = await server();
    const input = message();
    expect(
      (
        await createSystemMailClient({
          ...fixture.config,
          tls: 'starttls',
        }).sendNotification(input)
      ).kind,
    ).toBe('failed');
    expect(input.beforeDispatch).not.toHaveBeenCalled();
    expect(fixture.messages).toHaveLength(0);
  });
  it('rejects an untrusted certificate', async () => {
    const fixture = await server({ secure: true });
    const input = message();
    expect(
      (
        await createSystemMailClient({
          ...fixture.config,
          tls: 'implicit',
        }).sendNotification(input)
      ).kind,
    ).toBe('retryable');
    expect(input.beforeDispatch).not.toHaveBeenCalled();
  });
  it('records rejected authentication without sending the message', async () => {
    const fixture = await server({
      allowInsecureAuth: true,
      onAuth: (_auth, _session, callback) => {
        callback(Object.assign(new Error('Denied'), { responseCode: 535 }));
      },
    });
    const input = message();
    expect(
      (
        await createSystemMailClient({
          ...fixture.config,
          auth: { user: 'bad', pass: 'bad' },
        }).sendNotification(input)
      ).kind,
    ).toBe('failed');
    expect(input.beforeDispatch).not.toHaveBeenCalled();
  });
  it.each([
    [450, 'retryable'],
    [550, 'failed'],
  ] as const)(
    'classifies explicit %i recipient rejection as %s',
    async (code, kind) => {
      const fixture = await server({
        onRcptTo: (_address, _session, callback) => {
          callback(
            Object.assign(new Error('Rejected'), { responseCode: code }),
          );
        },
      });
      expect(
        (
          await createSystemMailClient(fixture.config).sendNotification(
            message(),
          )
        ).kind,
      ).toBe(kind);
      expect(fixture.messages).toHaveLength(0);
    },
  );
  it('refuses dispatch when the durable mark fails', async () => {
    const fixture = await server();
    const input = message({
      beforeDispatch: vi.fn().mockRejectedValue(new Error('Revoked')),
    });
    expect(
      (await createSystemMailClient(fixture.config).sendNotification(input))
        .kind,
    ).toBe('retryable');
    expect(fixture.messages).toHaveLength(0);
  });
  it('leaves a lost final DATA acknowledgement unknown after a bounded deadline', async () => {
    let received = false;
    const fixture = await server({
      onData: (stream) => {
        stream.resume();
        stream.on('end', () => {
          received = true;
        });
      },
    });
    expect(
      (
        await createSystemMailClient(fixture.config).sendNotification(
          message({ timeoutMillis: 300 }),
        )
      ).kind,
    ).toBe('unknown');
    expect(received).toBe(true);
  });
  it('closes an aborted dispatch while retaining uncertainty', async () => {
    const controller = new AbortController();
    const fixture = await server({
      onData: (stream) => {
        stream.resume();
        stream.on('end', () => {
          controller.abort();
        });
      },
    });
    expect(
      (
        await createSystemMailClient(fixture.config).sendNotification(
          message({ signal: controller.signal }),
        )
      ).kind,
    ).toBe('unknown');
  });
  it('does not connect after a preexisting cancellation', async () => {
    const input = message({ signal: AbortSignal.abort() });
    expect(
      (
        await createSystemMailClient({
          mode: 'smtp',
          host: '127.0.0.1',
          port: 1,
          tls: 'none',
        }).sendNotification(input)
      ).kind,
    ).toBe('retryable');
    expect(input.beforeDispatch).not.toHaveBeenCalled();
  });
});

describe('SMTP configuration', () => {
  const environment = {
    SYSTEM_MAIL_TRANSPORT: 'smtp',
    SYSTEM_MAIL_SMTP_HOST: 'smtp.example.test',
  };
  it('needs no Resend key and requires STARTTLS by default', () => {
    expect(
      parseSystemMailConfig(environment, 'AUTH_MAIL_EMAIL_API_KEY', true),
    ).toEqual({
      mode: 'smtp',
      host: 'smtp.example.test',
      port: 587,
      tls: 'starttls',
    });
    expect(
      parseSystemMailConfig(
        { ...environment, SYSTEM_MAIL_SMTP_TLS: 'implicit' },
        'INVITATION_EMAIL_API_KEY',
        true,
      ),
    ).toMatchObject({ port: 465, tls: 'implicit' });
  });
  it.each([
    { SYSTEM_MAIL_SMTP_TLS: 'none' },
    { SYSTEM_MAIL_SMTP_PORT: '0' },
    { SYSTEM_MAIL_SMTP_HOST: 'smtp://credentials@host' },
    { SYSTEM_MAIL_SMTP_USER: 'user' },
    { SYSTEM_MAIL_SMTP_PASSWORD: 'secret' },
    { SYSTEM_MAIL_TRANSPORT: 'unknown' },
  ])('rejects unsafe or partial deployed settings %j', (extra) => {
    expect(() =>
      parseSystemMailConfig(
        { ...environment, ...extra },
        'AUTH_MAIL_EMAIL_API_KEY',
        true,
      ),
    ).toThrow();
  });
  it('allows plaintext only on development loopback', () => {
    expect(
      parseSystemMailConfig(
        {
          ...environment,
          SYSTEM_MAIL_SMTP_HOST: '127.0.0.1',
          SYSTEM_MAIL_SMTP_TLS: 'none',
        },
        'AUTH_MAIL_EMAIL_API_KEY',
        false,
      ),
    ).toMatchObject({ tls: 'none' });
    expect(() =>
      parseSystemMailConfig(
        { ...environment, SYSTEM_MAIL_SMTP_TLS: 'none' },
        'AUTH_MAIL_EMAIL_API_KEY',
        false,
      ),
    ).toThrow();
  });
});
