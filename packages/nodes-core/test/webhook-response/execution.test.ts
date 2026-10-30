import { describe, expect, it, vi } from 'vitest';
import { createCoreNodeRegistry } from '../../src/server.js';
import { CORE_WEBHOOK_CONFIG_SCHEMA } from '../../src/index.js';
import type {
  NodeExecutionRuntime,
  NodeWebhookResponseRuntime,
} from '@pertexo/node-sdk/server';

const registry = createCoreNodeRegistry();
const identity = { key: 'core.respond_webhook', version: 1 };
function fixture(input: unknown, config: unknown = { bodyType: 'json' }) {
  const respond = vi
    .fn<NodeWebhookResponseRuntime['respond']>()
    .mockResolvedValue({ outcome: 'responded', statusCode: 201 });
  const runtime: NodeExecutionRuntime = {
    workspaceId: 'workspace',
    runId: 'run',
    nodeRunId: 'node-run',
    attemptId: 'attempt',
    attemptNumber: 1,
    nodeId: 'respond',
    invocationKey: 'root',
    sideEffectClass: 'safe',
    beforeDispatch: vi.fn(),
    webhookResponse: { respond },
  };
  return {
    respond,
    execute: () =>
      registry.execute({
        definition: identity,
        executor: identity,
        config,
        input,
        runtime,
        signal: new AbortController().signal,
      }),
  };
}
function sent(f: ReturnType<typeof fixture>) {
  const call = f.respond.mock.calls[0];
  if (call === undefined)
    throw new Error('Expected a response capability call');
  return call[0].response;
}
describe('Respond to webhook', () => {
  it('keeps old webhook config byte-for-byte empty and bounds opt-in waits', () => {
    expect(CORE_WEBHOOK_CONFIG_SCHEMA.parse({})).toEqual({});
    expect(
      CORE_WEBHOOK_CONFIG_SCHEMA.parse({
        responseMode: 'workflow',
        responseWaitSeconds: 30,
      }),
    ).toEqual({ responseMode: 'workflow', responseWaitSeconds: 30 });
    for (const value of [0, 31, 1.5])
      expect(
        CORE_WEBHOOK_CONFIG_SCHEMA.safeParse({ responseWaitSeconds: value })
          .success,
      ).toBe(false);
  });
  it('accepts valid HTTP token characters in custom x- response names', async () => {
    const f = fixture({
      body: {},
      headers: {
        'X-Report_Count': '1',
        'X-Report.Version': '2',
        'X-Content-Hash': 'sha256:example',
      },
    });
    await f.execute();
    expect(sent(f).headers).toEqual({
      'x-report_count': '1',
      'x-report.version': '2',
      'x-content-hash': 'sha256:example',
    });
  });
  it.each(['text/csv'] as const)(
    'sends exact %s text and normalized safe custom headers',
    async (textContentType) => {
      const f = fixture(
        { body: 'a,b\n1,2', headers: { 'X-Total-Count': '1' } },
        { bodyType: 'text', textContentType },
      );
      expect((await f.execute()).kind).toBe('succeeded');
      expect(sent(f)).toMatchObject({
        contentType: textContentType,
        body: 'a,b\n1,2',
        headers: { 'x-total-count': '1' },
      });
    },
  );
  it.each([
    'x-forwarded-for',
    'x-forwarded-host',
    'x-content-type-options',
    'x-accel-redirect',
    'x-sendfile',
    'set-cookie',
    'content-type',
    'access-control-allow-origin',
    'connection',
    'location',
  ])('refuses response-control header %s', async (name) => {
    const f = fixture({ body: {}, headers: { [name]: 'unsafe' } });
    await expect(f.execute()).rejects.toThrow('node input');
    expect(f.respond).not.toHaveBeenCalled();
  });
  it('refuses case-insensitive duplicates, excess headers and HTML formats', async () => {
    for (const input of [
      { body: {}, headers: { 'X-Count': '1', 'x-count': '2' } },
      {
        body: {},
        headers: Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`x-count-${String(i)}`, '1']),
        ),
      },
    ])
      await expect(fixture(input).execute()).rejects.toThrow('node input');
    await expect(
      fixture(
        { body: '<p>hello</p>' },
        { bodyType: 'text', textContentType: 'text/html' },
      ).execute(),
    ).rejects.toThrow('node config');
  });
  it('serializes a JSON reply once and continues with a small receipt', async () => {
    const f = fixture({
      body: { message: 'hello', amount: 12 },
      statusCode: 201,
      headers: { 'x-request-id': 'request-1' },
    });
    expect(await f.execute()).toEqual({
      kind: 'succeeded',
      output: { outcome: 'responded', statusCode: 201 },
    });
    expect(f.respond).toHaveBeenCalledWith({
      response: {
        body: '{"message":"hello","amount":12}',
        statusCode: 201,
        contentType: 'application/json',
        headers: { 'x-request-id': 'request-1' },
      },
      signal: f.respond.mock.calls[0]?.[0].signal,
    });
  });
  it('preserves every JSON body key and requires an explicit body', async () => {
    const value: unknown = JSON.parse(
      '{"__proto__":{"kept":1},"constructor":"data","nested":[{"__proto__":2}]}',
    );
    const f = fixture({ body: value });
    await f.execute();
    expect(JSON.parse(sent(f).body)).toEqual(value);
    const missing = fixture({});
    await expect(missing.execute()).rejects.toThrow('node input');
    expect(missing.respond).not.toHaveBeenCalled();
  });
  it.each([
    'set-cookie',
    'connection',
    'content-length',
    'content-type',
    'location',
    'transfer-encoding',
    '__proto__',
  ])('refuses %s rather than silently dropping it', async (name) => {
    const f = fixture({
      body: 'text',
      headers: Object.fromEntries([[name, 'value']]),
    });
    await expect(f.execute()).rejects.toThrow('node input');
    expect(f.respond).not.toHaveBeenCalled();
  });
  it.each(['value\r\nSet-Cookie: injected', 'value\u0000', 'value\t'])(
    'refuses header controls',
    async (value) => {
      const f = fixture({ body: null, headers: { 'x-request-id': value } });
      await expect(f.execute()).rejects.toThrow();
      expect(f.respond).not.toHaveBeenCalled();
    },
  );
  it('preserves exact Unicode text, defaults status and enforces empty body statuses', async () => {
    const f = fixture({ body: 'hello 👋\n' }, { bodyType: 'text' });
    await f.execute();
    expect(sent(f)).toEqual({
      body: 'hello 👋\n',
      statusCode: 200,
      contentType: 'text/plain',
      headers: {},
    });
    await expect(
      fixture({ body: { value: 1 } }, { bodyType: 'text' }).execute(),
    ).rejects.toThrow('text body');
    for (const statusCode of [204, 205, 304]) {
      await expect(
        fixture(
          { body: 'nonempty', statusCode },
          { bodyType: 'text' },
        ).execute(),
      ).rejects.toThrow('empty text');
      await expect(
        fixture({ body: null, statusCode }).execute(),
      ).rejects.toThrow('empty text');
      await expect(
        fixture({ body: '', statusCode }, { bodyType: 'text' }).execute(),
      ).resolves.toMatchObject({ kind: 'succeeded' });
    }
  });
  it.each([199, 600, 200.5])(
    'refuses non-final or invalid status %s',
    async (statusCode) => {
      const f = fixture({ body: null, statusCode });
      await expect(f.execute()).rejects.toThrow();
      expect(f.respond).not.toHaveBeenCalled();
    },
  );
  it('refuses unstoreable null bytes in text while JSON safely encodes them', async () => {
    const text = fixture({ body: 'a\u0000b' }, { bodyType: 'text' });
    await expect(text.execute()).rejects.toThrow('null character');
    expect(text.respond).not.toHaveBeenCalled();
    const json = fixture({ body: 'a\u0000b' });
    await json.execute();
    expect(sent(json).body).toBe('"a\\u0000b"');
  });
  it('keeps the existing envelope bound for a large response', async () => {
    const f = fixture({ body: 'x'.repeat(1_048_576) }, { bodyType: 'text' });
    await expect(f.execute()).rejects.toThrow('byte limit');
    expect(f.respond).not.toHaveBeenCalled();
    const within = fixture(
      { body: 'x'.repeat(1_040_000) },
      { bodyType: 'text' },
    );
    await within.execute();
    expect(Buffer.byteLength(sent(within).body)).toBe(1_040_000);
  });
});
