import { describe, expect, it } from 'vitest';
import { isMaskedAddress } from '../../src/server.js';

// Webhook shapes on reserved hosts: the rule reads only the path, and real
// provider hosts would look like leaked secrets to secret scanning.
describe('assistant address masking', () => {
  it.each([
    [
      'a Slack-style incoming webhook',
      'https://hooks.chat.example.test/services/T0123ABCD/B0123ABCDEF/abcdEFGH1234ijklMNOP5678',
    ],
    [
      'a Discord-style webhook',
      'https://chat.example.test/api/webhooks/123456789012345678/AbC-dEf_123GhIjKlMnOpQrStUvWxYz0123456789',
    ],
    [
      'a Telegram-style bot address',
      'https://bots.example.test/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage',
    ],
    ['user information', 'https://reporter@api.example.test/orders'],
    ['a user and password', 'https://reporter:pass@api.example.test/orders'],
    ['a query string', 'https://api.example.test/orders?status=open'],
    [
      'a UUID in the path',
      'https://api.example.test/orders/123e4567-e89b-12d3-a456-426614174000',
    ],
  ])('masks an address with %s', (_case, address) => {
    expect(isMaskedAddress(address)).toBe(true);
  });

  it.each([
    'https://api.example.test/v2/orders',
    'https://api.example.test/orders/{orderId}/items',
    'https://hooks.example.test/a-very-long-readable-path-segment',
    'http://localhost:8080/health',
  ])('shows the ordinary address %s', (address) => {
    expect(isMaskedAddress(address)).toBe(false);
  });

  it('masks a value that is not text', () => {
    expect(isMaskedAddress({ url: 'https://api.example.test' })).toBe(true);
  });
});
