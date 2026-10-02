import { describe, expect, it } from 'vitest';
import {
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
} from '../src/registry.js';
import { platformPortableDefinitionPolicy } from '../src/server.js';

describe('registered portable definition policy', () => {
  it('derives exact registered slots/config schemas without executor/credential access', () => {
    const policy = platformPortableDefinitionPolicy(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    );
    const http = policy.definitions.find(({ key }) => key === 'http.request');
    expect(http?.slots).toEqual([
      { slot: 'http_headers', providerKey: 'http', authType: 'http_headers' },
    ]);
    const config = {
      method: 'GET',
      url: 'https://provider.example.test/resource',
      headers: {},
      timeoutMillis: 1000,
      maxRedirects: 1,
      maxResponseBytes: 1024,
      inlineResponseBytes: 512,
    };
    expect(http?.validateConfig(config)).toBe(true);
    const admittedConfig: Record<string, unknown> = Object.assign(
      Object.create(null) as Record<string, unknown>,
      config,
      { headers: Object.create(null) as Record<string, unknown> },
    );
    expect(http?.validateConfig(admittedConfig)).toBe(true);
    expect(
      http?.validateConfig({ ...admittedConfig, url: ` ${config.url} ` }),
    ).toBe(false);
    expect(
      http?.validateConfig({
        ...config,
        headers: { Authorization: 'private' },
      }),
    ).toBe(false);
    expect(
      http?.validateConfig({
        ...config,
        url: 'https://user:private@provider.example.test',
      }),
    ).toBe(false);
    expect(
      http?.validateConfig({
        ...config,
        url: 'https://provider.example.test?token=private',
      }),
    ).toBe(false);
    expect(http?.validateConfig({ ...config, unexpected: true })).toBe(false);
    expect(
      policy.selectionFingerprint([{ key: 'http.request', version: 1 }]),
    ).toMatch(/^node-select:v1:sha256:[a-f0-9]{64}$/u);
  });
  it('uses independently declared provider policies and refuses unsupported releases', () => {
    const policy = platformPortableDefinitionPolicy(
      PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
    );
    expect(
      policy.definitions.find(({ key }) => key === 'email.send_notification')
        ?.slots,
    ).toEqual([
      {
        slot: 'resend_api_key',
        providerKey: 'email',
        authType: 'resend_api_key',
      },
    ]);
    expect(
      policy.definitions.find(({ key }) => key === 'slack.send_message')?.slots,
    ).toEqual([
      {
        slot: 'slack_bot_token',
        providerKey: 'slack',
        authType: 'slack_bot_token',
      },
    ]);
    expect(() => platformPortableDefinitionPolicy({})).toThrow();
  });
});
