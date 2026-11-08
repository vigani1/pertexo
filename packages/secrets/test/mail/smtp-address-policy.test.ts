import { SMTPServer } from 'smtp-server';
import { describe, expect, it, vi } from 'vitest';
import { parseAllowedPrivateNetworks } from '../../src/outbound-http/transport/address-policy.js';
import { createSmtpClient } from '../../src/mail/smtp.js';

const dns = vi.hoisted(() => ({ address: '127.0.0.1' }));
// DNS is an outside service. The SMTP socket and protocol stay real.
vi.mock('node:dns/promises', () => ({
  lookup: () => Promise.resolve([{ address: dns.address, family: 4 }]),
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
