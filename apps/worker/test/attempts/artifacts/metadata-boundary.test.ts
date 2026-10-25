import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createNodeArtifactRuntimeFactory } from '../../../src/attempts/artifacts/runtime.js';
import { artifactWriteMetadataSchema } from '../../../src/attempts/artifacts/policy.js';

describe('executor artifact metadata boundary', () => {
  it.each([
    'application/js\u000bon',
    'application/js\u001fon',
    'application/js\u007fon',
    'application/js\u0100on',
  ])(
    'rejects HTTP-unsafe media type %j before spooling or storage',
    async (mediaType) => {
      const spool = vi.fn();
      const createPending = vi.fn();
      const runtime = createNodeArtifactRuntimeFactory({
        persistence: { createPending, finalize: vi.fn() },
        store: { put: vi.fn() },
        scratch: { spool } as never,
        maximumBytes: 100,
        assertOpen: () => undefined,
        retentionMillis: 1000,
      })({
        workspaceId: 'workspace',
        runId: 'run',
        nodeRunId: 'node-run',
        attemptId: 'attempt',
        attemptNumber: 1,
        nodeId: 'node',
        invocationKey: 'root',
        workerId: 'worker',
      });
      await expect(
        runtime.write({
          body: Readable.from([Buffer.from('value')]),
          maxBytes: 100,
          mediaType,
          purpose: 'node-output',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      expect(spool).not.toHaveBeenCalled();
      expect(createPending).not.toHaveBeenCalled();
    },
  );
  it('normalizes media types and retains the purpose limit and format', () => {
    expect(
      artifactWriteMetadataSchema.parse({
        mediaType: ' application/json ',
        purpose: 'node-output',
      }),
    ).toEqual({ mediaType: 'application/json', purpose: 'node-output' });
    for (const purpose of ['', 'x'.repeat(65), 'Node output'])
      expect(() =>
        artifactWriteMetadataSchema.parse({ mediaType: 'text/plain', purpose }),
      ).toThrow();
  });
});
