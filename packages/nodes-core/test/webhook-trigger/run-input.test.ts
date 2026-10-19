import { describe, expect, it } from 'vitest';

import {
  CORE_WEBHOOK_CONFIG_SCHEMA,
  webhookRunInput,
  type WebhookRequest,
} from '../../src/index.js';

const post: WebhookRequest = {
  method: 'POST',
  body: { orderId: 'A-1' },
  query: { source: 'shop' },
  headers: { 'user-agent': 'shop/1' },
};

describe('webhook run input', () => {
  it('gives a POST its body and a GET its query by default', () => {
    expect(webhookRunInput(undefined, post)).toEqual({ orderId: 'A-1' });
    expect(webhookRunInput('body', post)).toEqual({ orderId: 'A-1' });
    expect(
      webhookRunInput('body', { ...post, method: 'GET', body: {} }),
    ).toEqual({ source: 'shop' });
  });

  it('gives the whole request when asked', () => {
    expect(webhookRunInput('request', post)).toEqual({
      method: 'POST',
      body: { orderId: 'A-1' },
      query: { source: 'shop' },
      headers: { 'user-agent': 'shop/1' },
    });
  });

  it('keeps triggers saved before the setting existed valid', () => {
    expect(CORE_WEBHOOK_CONFIG_SCHEMA.parse({})).toEqual({});
    expect(
      CORE_WEBHOOK_CONFIG_SCHEMA.safeParse({ runInput: 'headers' }).success,
    ).toBe(false);
  });
});
