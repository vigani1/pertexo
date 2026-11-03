import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';

const fixture = (name: string) => new URL(`./${name}`, import.meta.url);
const owners: SMTPServer[] = [];
afterEach(async () => {
  await Promise.all(
    owners.splice(0).map(
      (relay) =>
        new Promise<void>((resolve) => {
          relay.close(resolve);
        }),
    ),
  );
});

async function startRelay(secure: boolean) {
  const logins: { username: string; password: string }[] = [];
  const messages: string[] = [];
  const relay = new SMTPServer({
    key: readFileSync(fixture('localhost.key')),
    cert: readFileSync(fixture('localhost.crt')),
    logger: false,
    secure,
    authOptional: false,
    onAuth: (auth, _session, callback) => {
      logins.push({
        username: auth.username ?? '',
        password: auth.password ?? '',
      });
      callback(null, { user: auth.username });
    },
    onData: (stream, _session, callback) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        messages.push(Buffer.concat(chunks).toString());
        callback();
      });
    },
  });
  // The client's connection closing is not this test's concern.
  relay.on('error', (error: Error) => {
    expect(error).toBeDefined();
  });
  owners.push(relay);
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.server.address();
  if (!address || typeof address === 'string')
    throw new Error('SMTP fixture unavailable');
  return { port: address.port, logins, messages };
}

// Settings go in as an operator writes them, through the deployed parser, and the
// send happens in its own process, as it does in the worker.
function sendThroughDeployedSettings(
  tls: 'starttls' | 'implicit',
  port: number,
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(fixture('send-once.fixture.mjs'))],
        {
          env: {
            NODE_ENV: 'production',
            NODE_EXTRA_CA_CERTS: fileURLToPath(fixture('localhost.crt')),
            PATH: process.env.PATH,
            SYSTEM_MAIL_TRANSPORT: 'smtp',
            SYSTEM_MAIL_SMTP_HOST: 'localhost',
            SYSTEM_MAIL_SMTP_PORT: String(port),
            SYSTEM_MAIL_SMTP_TLS: tls,
            SYSTEM_MAIL_SMTP_USER: 'relay-user',
            SYSTEM_MAIL_SMTP_PASSWORD: 'relay-password',
          },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.once('close', (status) => {
        resolve({ status, stdout, stderr });
      });
    },
  );
}

describe('a relay that needs a login', () => {
  // ops-02: the parser freezes `auth`, and nodemailer writes onto it from a socket
  // callback, which would kill the worker with an uncaught TypeError on every sign-up.
  it.each(['starttls', 'implicit'] as const)(
    'gets the login and the message over %s from settings an operator wrote',
    async (tls) => {
      const relay = await startRelay(tls === 'implicit');
      const sent = await sendThroughDeployedSettings(tls, relay.port);
      expect(sent.stderr).toBe('');
      expect(sent.status).toBe(0);
      expect(JSON.parse(sent.stdout)).toEqual({ kind: 'submitted' });
      expect(relay.logins).toEqual([
        { username: 'relay-user', password: 'relay-password' },
      ]);
      expect(relay.messages).toHaveLength(1);
      expect(relay.messages[0]).toContain('To: ada@example.test');
    },
  );
});
