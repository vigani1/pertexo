import { readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { SMTPServer } from 'smtp-server';
import { describe, expect, it, vi } from 'vitest';
import { parseAllowedPrivateNetworks } from '../../src/outbound-http/transport/address-policy.js';
import { createSmtpClient } from '../../src/mail/smtp.js';

const dns = vi.hoisted(() => ({
  address: '127.0.0.1',
  extra: [] as { address: string; family: number }[],
}));
// DNS is an outside service. The SMTP socket and protocol stay real.
vi.mock('node:dns/promises', () => ({
  lookup: () =>
    Promise.resolve([{ address: dns.address, family: 4 }, ...dns.extra]),
}));

describe('SMTP resolved-address policy', () => {
  it('pins a checked DNS answer and checks a changed answer again on the next connection', async () => {
    let connections = 0;
    const relay = new SMTPServer({
      logger: false,
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onConnect: (_session, callback) => {
        connections += 1;
        callback();
      },
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    try {
      const address = relay.server.address();
      if (!address || typeof address === 'string')
        throw new Error('SMTP fixture not listening');
      const client = createSmtpClient(
        {
          mode: 'smtp',
          host: 'unresolvable-relay.invalid',
          port: address.port,
          tls: 'none',
        },
        {
          allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
          allowPlaintext: true,
        },
      );
      expect(await client.verify({ timeoutMillis: 2000 })).toEqual({
        kind: 'submitted',
        reference: '',
      });
      dns.address = '169.254.169.254';
      expect(await client.verify({ timeoutMillis: 2000 })).toMatchObject({
        kind: 'failed',
        failure: { category: 'network' },
      });
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => {
        relay.close(resolve);
      });
    }
  });
});

it('rejects a mixed DNS answer before connecting to even the allowed relay', async () => {
  let connections = 0;
  const relay = new SMTPServer({
    logger: false,
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onConnect: (_session, callback) => {
      connections += 1;
      callback();
    },
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  try {
    const address = relay.server.address();
    if (!address || typeof address === 'string') throw new Error('No relay');
    dns.address = '127.0.0.1';
    dns.extra = [{ address: '169.254.169.254', family: 4 }];
    const result = await createSmtpClient(
      { mode: 'smtp', host: 'relay.invalid', port: address.port, tls: 'none' },
      {
        allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
        allowPlaintext: true,
      },
    ).verify({ timeoutMillis: 2000 });
    expect(result).toEqual({
      kind: 'failed',
      failure: { category: 'network' },
    });
    expect(connections).toBe(0);
  } finally {
    dns.extra = [];
    await new Promise<void>((resolve) => {
      relay.close(resolve);
    });
  }
});

it('rejects a trusted certificate for a different hostname after DNS pinning', async () => {
  const trusted = getCACertificates('default');
  const cert = readFileSync(new URL('./localhost.crt', import.meta.url));
  const relay = new SMTPServer({
    key: readFileSync(new URL('./localhost.key', import.meta.url)),
    cert,
    secure: true,
    logger: false,
    authOptional: true,
  });
  relay.on('error', (error: Error & { code?: string; report?: boolean }) => {
    if (error.code !== 'SocketError' || error.report !== false) throw error;
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  try {
    setDefaultCACertificates([...trusted, cert.toString()]);
    dns.address = '127.0.0.1';
    const address = relay.server.address();
    if (!address || typeof address === 'string') throw new Error('No relay');
    const result = await createSmtpClient(
      {
        mode: 'smtp',
        host: 'wrong-relay.invalid',
        port: address.port,
        tls: 'implicit',
      },
      {
        allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
        allowPlaintext: false,
      },
    ).verify({ timeoutMillis: 2000 });
    expect(result).toMatchObject({ failure: { category: 'tls' } });
  } finally {
    setDefaultCACertificates(trusted);
    await new Promise<void>((resolve) => {
      relay.close(resolve);
    });
  }
});
