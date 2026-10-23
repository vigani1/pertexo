import { verifiedSource, sourceBytes } from '../support/artifact-runtime.js';

import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';
import { httpRequestInputSchema } from '../../src/index.js';
import { createHttpRequestExecutorRegistration } from '../../src/server.js';
import {
  encoder,
  config,
  runtime,
  invocation,
  response,
  streamingHttpClient,
} from '../support/http-execution.js';
describe('HTTP artifact request bodies', () => {
  const reference = {
    artifactId: '44444444-4444-4444-8444-444444444444',
    byteLength: 4,
    mediaType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
  };
  it('sends exact verified bytes, sets MIME type and clears owned bytes afterwards', async () => {
    const bytes = new Uint8Array([0, 255, 128, 42]);
    const read = vi.fn().mockResolvedValue(verifiedSource(bytes));
    const state = runtime({
      artifacts: { openVerified: read, write: vi.fn() },
    });
    const sent: Uint8Array[] = [];
    const headers: Record<string, string>[] = [];
    const httpClient = streamingHttpClient(async (request) => {
      await request.beforeDispatch();
      if (request.body === undefined) throw new Error('File body missing');
      sent.push(Uint8Array.from(await sourceBytes(request.body)));
      headers.push({ ...request.headers });
      return response(encoder.encode('{}'));
    });
    const signal = new AbortController().signal;
    await createHttpRequestExecutorRegistration({ httpClient }).execute(
      invocation(state.value, {
        signal,
        input: { body: { kind: 'artifact', ...reference } },
      }),
    );
    expect(sent).toEqual([new Uint8Array([0, 255, 128, 42])]);
    expect(headers[0]?.['content-type']).toBe(reference.mediaType);
    expect(read).toHaveBeenCalledWith({
      reference,
      maxBytes: 10485760,
      signal,
    });
    expect(bytes).toEqual(new Uint8Array(4));
    expect(state.beforeDispatch).toHaveBeenCalledOnce();
  });
  it('retains an explicit content type', async () => {
    const state = runtime({
      artifacts: {
        openVerified: vi
          .fn()
          .mockResolvedValue(verifiedSource(new Uint8Array(4))),
        write: vi.fn(),
      },
    });
    const httpClient = streamingHttpClient(async (request) => {
      expect(request.headers?.['content-type']).toBe('application/custom');
      await request.beforeDispatch();
      return response(encoder.encode('{}'));
    });
    await createHttpRequestExecutorRegistration({ httpClient }).execute(
      invocation(state.value, {
        config: config({ headers: { 'Content-Type': 'application/custom' } }),
        input: { body: { kind: 'artifact', ...reference } },
      }),
    );
  });
  it.each(['GET', 'HEAD'])(
    'rejects %s file bodies before reading or dispatching',
    async (method) => {
      const read = vi.fn();
      const state = runtime({
        artifacts: { openVerified: read, write: vi.fn() },
      });
      const httpClient = { executeStreaming: vi.fn() };
      await expect(
        createHttpRequestExecutorRegistration({ httpClient }).execute(
          invocation(state.value, {
            config: config({ method }),
            input: { body: { kind: 'artifact', ...reference } },
          }),
        ),
      ).rejects.toMatchObject({ kind: 'failed', possiblyDispatched: false });
      expect(read).not.toHaveBeenCalled();
      expect(httpClient.executeStreaming).not.toHaveBeenCalled();
    },
  );
  it('does not dispatch when read fails, and preserves preexisting dispatch uncertainty', async () => {
    const read = vi.fn().mockRejectedValue(
      new NodeExecutorFailure({
        kind: 'failed',
        errorKind: 'configuration',
        possiblyDispatched: false,
      }),
    );
    const httpClient = { executeStreaming: vi.fn() };
    for (const unresolved of [false, true]) {
      const state = runtime({
        artifacts: { openVerified: read, write: vi.fn() },
        ...(unresolved ? { providerDispatchUnresolved: true as const } : {}),
      });
      await expect(
        createHttpRequestExecutorRegistration({ httpClient }).execute(
          invocation(state.value, {
            input: { body: { kind: 'artifact', ...reference } },
          }),
        ),
      ).rejects.toMatchObject({
        kind: unresolved ? 'outcome_unknown' : 'failed',
        possiblyDispatched: unresolved,
      });
      expect(state.beforeDispatch).not.toHaveBeenCalled();
    }
    expect(httpClient.executeStreaming).not.toHaveBeenCalled();
  });
  it('accepts the exact maximum descriptor and rejects oversized or malformed references', () => {
    expect(
      httpRequestInputSchema.safeParse({
        body: { kind: 'artifact', ...reference, byteLength: 10485760 },
      }).success,
    ).toBe(true);
    for (const patch of [
      { byteLength: 10485761 },
      { artifactId: 'bad' },
      { sha256: 'bad' },
      { mediaType: 'text/plain\r\nInjected: value' },
      { storageKey: 'arbitrary' },
    ])
      expect(
        httpRequestInputSchema.safeParse({
          body: { kind: 'artifact', ...reference, ...patch },
        }).success,
      ).toBe(false);
  });
});
