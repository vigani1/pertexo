import { inlineBytes } from '../../support/artifact-runtime.js';

import { NodeDispatchEvidenceError } from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createHttpRequestExecutorRegistration,
  type HttpRequestExecutorDependencies,
  type SecureHttpRequest,
} from '../../../src/server.js';
import {
  connectionId,
  secretVersionId,
  encoder,
  config,
  runtime,
  invocation,
  response,
  streamingHttpClient,
} from '../../support/http-execution.js';
describe('http.request@1 server executor', () => {
  it('resolves credentials just in time, marks before I/O, and returns bounded inline output', async () => {
    const state = runtime();
    let requestBody: Uint8Array | undefined;
    const providerBody = encoder.encode('{"created":true}');
    const dispatch = vi.fn(async (request: SecureHttpRequest) => {
      expect(request.headers).toEqual({
        accept: 'application/json',
        authorization: 'Bearer executor-secret',
      });
      expect(request.sensitiveValues).toEqual([
        'Bearer executor-secret',
        'executor-secret',
      ]);
      requestBody = inlineBytes(request.body);
      await request.beforeDispatch();
      expect(state.beforeDispatch).toHaveBeenCalledOnce();
      return response(providerBody);
    });
    const httpClient = streamingHttpClient(dispatch);
    const measure = vi.fn<
      NonNullable<HttpRequestExecutorDependencies['telemetry']>['measure']
    >((work) => work());
    const registration = createHttpRequestExecutorRegistration({
      httpClient,
      telemetry: { measure },
    });

    await expect(
      registration.execute(invocation(state.value)),
    ).resolves.toMatchObject({
      status: 201,
      body: {
        kind: 'inline',
        encoding: 'utf8',
        value: '{"created":true}',
      },
      finalOrigin: 'https://provider.example.test',
    });
    expect(state.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
      }),
    );
    expect(state.assertCurrent).toHaveBeenCalledOnce();
    const assertInput = state.assertCurrent.mock.calls[0]?.[0];
    expect(assertInput).toMatchObject({
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      secretVersionId,
    });
    expect(assertInput?.signal).toBeInstanceOf(AbortSignal);
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
    expect(requestBody?.every((byte) => byte === 0)).toBe(true);
    expect(providerBody.every((byte) => byte === 0)).toBe(true);
    expect(measure).toHaveBeenCalledOnce();
  });
  it.each([
    [
      'application/json',
      '{"order":{"id":7,"tags":["a"]}}',
      { order: { id: 7, tags: ['a'] } },
    ],
    [
      'application/problem+json; charset=utf-8',
      '{"title":"Gone"}',
      { title: 'Gone' },
    ],
    ['text/plain', '{"order":1}', undefined],
    ['application/json', '{"order": ', undefined],
    ['application/json', `${'['.repeat(60)}${']'.repeat(60)}`, undefined],
  ])(
    'parses a %s response for later steps when it is JSON within the limits',
    async (contentType, text, json) => {
      const registration = createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(async (request) => {
          await request.beforeDispatch();
          return {
            ...response(encoder.encode(text), 200),
            headers: { 'content-type': contentType },
          };
        }),
      });
      const output = await registration.execute(invocation(runtime().value));
      expect(output).toMatchObject({
        body: { kind: 'inline', encoding: 'utf8', value: text },
      });
      expect((output as { body: { json?: unknown } }).body.json).toEqual(json);
    },
  );
  it('sends run data filled into {placeholders}, keeping the configured origin', async () => {
    let sent: SecureHttpRequest | undefined;
    const registration = createHttpRequestExecutorRegistration({
      httpClient: streamingHttpClient(async (request) => {
        sent = request;
        await request.beforeDispatch();
        return response(encoder.encode('{}'), 200);
      }),
    });
    await registration.execute(
      invocation(runtime().value, {
        config: config({
          method: 'GET',
          url: 'https://provider.example.test/v1/items/{itemId}?q={term}',
          headers: { accept: 'application/json', 'x-customer': '{customer}' },
        }),
        input: { itemId: 'a/b', term: 'x&y', customer: 42 },
      }),
    );
    expect(sent?.url).toBe(
      'https://provider.example.test/v1/items/a%2Fb?q=x%26y',
    );
    expect(sent?.headers).toMatchObject({ 'x-customer': '42' });
    await expect(
      registration.execute(
        invocation(runtime().value, {
          config: config({
            method: 'GET',
            url: 'https://provider.example.test/v1/items/{itemId}',
          }),
          input: {},
        }),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      cause: 'Map a value for {itemId}.',
    });
  });
  it('calls a public API without a connection, marking dispatch without a fence', async () => {
    const state = runtime();
    let sent: SecureHttpRequest | undefined;
    const registration = createHttpRequestExecutorRegistration({
      httpClient: streamingHttpClient(async (request) => {
        sent = request;
        await request.beforeDispatch();
        return response(encoder.encode('{"ok":true}'), 200);
      }),
    });
    await expect(
      registration.execute(
        invocation(state.value, {
          config: config({ method: 'GET' }),
          input: {},
          connectionRefs: {},
        }),
      ),
    ).resolves.toMatchObject({ status: 200, body: { json: { ok: true } } });
    expect(sent?.headers).toEqual({ accept: 'application/json' });
    expect(sent?.sensitiveValues).toEqual([]);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.assertCurrent).not.toHaveBeenCalled();
    expect(state.beforeDispatch).toHaveBeenCalledWith();
    await expect(
      registration.execute(
        invocation(state.value, {
          config: config({ method: 'GET' }),
          input: {},
          connectionRefs: { other: connectionId },
        }),
      ),
    ).rejects.toMatchObject({
      decision: { kind: 'failed', errorKind: 'configuration' },
    });
  });
  it('atomically forwards the resolved connection fence after a rotation race', async () => {
    const state = runtime();
    const rotatedSecretVersionId = '88888888-8888-4888-8888-888888888888';
    let currentSecretVersionId = secretVersionId;
    let providerBytesSent = false;
    state.assertCurrent.mockImplementationOnce((input) => {
      expect(input.secretVersionId).toBe(secretVersionId);
      currentSecretVersionId = rotatedSecretVersionId;
      return Promise.resolve();
    });
    state.beforeDispatch.mockImplementation((input) => {
      // The old provider adapter omitted the fence, so this test double
      // models a marker implementation that cannot reject a stale dispatch.
      if (input?.connectionFence === undefined) return Promise.resolve();
      if (
        input.providerDispatchBinding !==
        'http:sha256:23d10e242277ade1ff3b50b0a5bed60a0b4366a6af4ffd42dff3a17ba0c2e847'
      )
        throw new NodeDispatchEvidenceError(
          'provider_dispatch_binding_mismatch',
        );
      if (input.connectionFence.secretVersionId !== currentSecretVersionId)
        throw new NodeDispatchEvidenceError('provider_connection_fence_failed');
      return Promise.resolve();
    });
    const registration = createHttpRequestExecutorRegistration({
      httpClient: streamingHttpClient(async (request) => {
        await request.beforeDispatch();
        providerBytesSent = true;
        return response(new TextEncoder().encode('{"created":true}'));
      }),
    });

    await expect(
      registration.execute(invocation(state.value)),
    ).rejects.toMatchObject({
      decision: {
        kind: 'failed',
        errorKind: 'authentication',
      },
      possiblyDispatched: false,
    });
    expect(providerBytesSent).toBe(false);
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
    expect(state.beforeDispatch).toHaveBeenCalledWith({
      connectionFence: {
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
        secretVersionId,
      },
      providerDispatchBinding:
        'http:sha256:23d10e242277ade1ff3b50b0a5bed60a0b4366a6af4ffd42dff3a17ba0c2e847',
    });
  });
  it('writes large output through the artifact capability and returns only its reference', async () => {
    const state = runtime();
    const providerBody = new Uint8Array(70_000).fill(7);
    const httpClient = streamingHttpClient(
      vi.fn(async (request: SecureHttpRequest) => {
        await request.beforeDispatch();
        return response(providerBody);
      }),
    );
    const registration = createHttpRequestExecutorRegistration({ httpClient });

    const output = await registration.execute(invocation(state.value));
    expect(output).toMatchObject({
      body: {
        kind: 'artifact',
        artifactId: '44444444-4444-4444-8444-444444444444',
        byteLength: 70_000,
      },
    });
    expect(state.write).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytes: 1_048_576,
        purpose: 'node-output',
      }),
    );
    expect(state.written).toHaveLength(70_000);
    expect(state.written.every((byte) => byte === 7)).toBe(true);
    expect(providerBody.every((byte) => byte === 0)).toBe(true);
  });
});
