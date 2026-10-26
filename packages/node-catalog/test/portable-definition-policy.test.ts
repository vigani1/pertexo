import { describe, expect, it } from 'vitest';
import { platformPortableDefinitionPolicy } from '../src/server.js';

describe('registered portable definition policy', () => {
  it('derives exact registered slots/config schemas without executor/credential access', () => {
    const policy = platformPortableDefinitionPolicy();
    const http = policy.definitions.find(({ key }) => key === 'http.request');
    // A public API needs no key, so an import may leave this slot unbound.
    expect(http?.slots).toEqual([
      {
        slot: 'http_headers',
        providerKey: 'http',
        authType: 'http_headers',
        optional: true,
      },
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
  });
  it('keeps Create file formats and ordered columns portable', () => {
    const definition = platformPortableDefinitionPolicy().definitions.find(
      ({ key }) => key === 'core.create_file',
    );
    expect(definition?.slots).toEqual([]);
    for (const format of ['json', 'text'])
      expect(definition?.validateConfig({ format })).toBe(true);
    expect(
      definition?.validateConfig({
        format: 'csv',
        delimiter: ',',
        columns: ['b', 'a'],
      }),
    ).toBe(true);
    expect(
      definition?.validateConfig({
        format: 'csv',
        delimiter: ',',
        columns: ['a', 'a'],
      }),
    ).toBe(false);
    expect(definition?.validateConfig({ format: 'csv', delimiter: ',' })).toBe(
      false,
    );
    expect(definition?.validateConfig({ format: 'text', columns: [] })).toBe(
      false,
    );
  });
  it('preserves explicit Read file formats and conversion choices in portable definitions', () => {
    const definition = platformPortableDefinitionPolicy().definitions.find(
      ({ key }) => key === 'core.read_file',
    );
    expect(definition?.slots).toEqual([]);
    expect(definition?.validateConfig({ format: 'json' })).toBe(true);
    for (const delimiter of [',', ';', '\t'])
      for (const convertValues of [true, false])
        expect(
          definition?.validateConfig({
            format: 'csv',
            delimiter,
            convertValues,
          }),
        ).toBe(true);
    expect(definition?.validateConfig({ format: 'json', delimiter: ',' })).toBe(
      false,
    );
    expect(
      definition?.validateConfig({
        format: 'csv',
        delimiter: '|',
        convertValues: true,
      }),
    ).toBe(false);
    // Imports keep exact setup data; the editor materializes the runtime default.
    expect(definition?.validateConfig({ format: 'csv', delimiter: ',' })).toBe(
      false,
    );
  });
  it('uses independently declared provider policies', () => {
    const policy = platformPortableDefinitionPolicy();
    expect(
      policy.definitions.find(({ key }) => key === 'email.send_notification')
        ?.slots,
    ).toEqual([
      {
        slot: 'resend_api_key',
        providerKey: 'email',
        authType: 'resend_api_key',
        optional: false,
      },
    ]);
    expect(
      policy.definitions.find(({ key }) => key === 'slack.send_message')?.slots,
    ).toEqual([
      {
        slot: 'slack_bot_token',
        providerKey: 'slack',
        authType: 'slack_bot_token',
        optional: false,
      },
    ]);
  });
});

it('preserves legacy approval setup without inserting a starter or expiry default', () => {
  const definition = platformPortableDefinitionPolicy().definitions.find(
    ({ key }) => key === 'core.approval',
  );
  const legacy = {
    title: 'Approval needed',
    instructions: '',
    expiresAfterSeconds: 604800,
    audience: { roles: ['owner', 'admin'], memberIds: [] },
  };
  expect(definition?.validateConfig(legacy)).toBe(true);
  for (const allowed of [true, false])
    expect(
      definition?.validateConfig({ ...legacy, allowStarterToDecide: allowed }),
    ).toBe(true);
  expect(
    definition?.validateConfig({ ...legacy, allowStarterToDecide: 'true' }),
  ).toBe(false);
  for (const onExpiry of ['fail', 'continue'])
    expect(definition?.validateConfig({ ...legacy, onExpiry })).toBe(true);
  expect(definition?.validateConfig({ ...legacy, onExpiry: 'later' })).toBe(
    false,
  );
});

it('exports old Form setup and explicit acceptance messages and multi-selects without rewriting them', () => {
  const definition = platformPortableDefinitionPolicy().definitions.find(
    ({ key }) => key === 'core.form',
  );
  const field = {
    id: 'message',
    name: 'message',
    label: 'Message',
    type: 'text',
    help: '',
    required: true,
  };
  const config = { title: 'Send a request', instructions: '', fields: [field] };
  expect(definition?.validateConfig(config)).toBe(true);
  expect(
    definition?.validateConfig({ ...config, thankYouMessage: 'Received.' }),
  ).toBe(true);
  expect(
    definition?.validateConfig({
      ...config,
      fields: [{ ...field, type: 'multi_select', options: ['A', 'B'] }],
    }),
  ).toBe(true);
});
