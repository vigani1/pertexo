import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ArtifactStore } from '@pertexo/artifact-store';
import { artifactStorageKey } from '@pertexo/database/execution';
import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  type WorkflowExecutionValueArtifact,
  type WorkflowExecutionValueOwner,
} from '../src/execution/workflow-execution-value-codec.js';
import {
  createWorkflowExecutionValueWriter,
  type WorkflowExecutionValueWriterPersistence,
} from '../src/execution/workflow-execution-value-writer.js';
import {
  lease,
  WORKSPACE_ID,
  RUN_ID,
  VERSION_ID,
  OUTBOX_EVENT_ID,
} from './support/node-attempt-handler.fixture.js';

const artifactId = '88888888-8888-4888-8888-888888888888';
const attemptOwner: WorkflowExecutionValueOwner = {
  kind: 'attempt',
  lease: lease(),
};
const runOwner: WorkflowExecutionValueOwner = {
  kind: 'run_result',
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  workflowVersionId: VERSION_ID,
  expectedRevision: 4,
  delivery: { outboxEventId: OUTBOX_EVENT_ID, payloadChecksum: 'a'.repeat(64) },
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function metadata(bytes: Uint8Array): WorkflowExecutionValueArtifact {
  return Object.freeze({
    artifactId,
    workspaceId: WORKSPACE_ID,
    byteLength: bytes.byteLength,
    sha256: digest(bytes),
    mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
    available: false,
  });
}

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(Uint8Array.from(bytes.subarray(0, 2)));
  yield Uint8Array.from(bytes.subarray(2));
}

async function harness() {
  const spoolDirectory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-value-writer-test-'),
  );
  temporaryDirectories.push(spoolDirectory);
  const events: string[] = [];
  const bytes = Buffer.from('{"name":"input"}');
  const reserved = metadata(bytes);
  const assertReserved = vi.fn<
    WorkflowExecutionValueWriterPersistence['assertReserved']
  >(() => {
    events.push('assert');
    return Promise.resolve();
  });
  const finalize = vi.fn<WorkflowExecutionValueWriterPersistence['finalize']>(
    () => {
      events.push('finalize');
      return Promise.resolve();
    },
  );
  const createPending = vi.fn();
  const reserve = vi.fn();
  let uploadedBytes: Buffer | undefined;
  const put = vi.fn<ArtifactStore['put']>(async (input) => {
    events.push('put');
    const consumed: Buffer[] = [];
    for await (const chunk of input.body) {
      const value: unknown = chunk;
      if (!(value instanceof Uint8Array))
        throw new TypeError('Expected upload bytes');
      consumed.push(Buffer.from(value));
    }
    uploadedBytes = Buffer.concat(consumed);
    return {
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
      byteLength: input.byteLength,
      mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
      sha256: input.sha256,
    };
  });
  const openFile = vi.fn(async (filePath: string) => {
    const file = await open(filePath, 'wx', 0o600);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    return file;
  });
  const removeDirectory = vi.fn((directory: string) =>
    rm(directory, { recursive: true, force: true }),
  );
  const persistence = { assertReserved, finalize, createPending, reserve };
  const writer = createWorkflowExecutionValueWriter({
    persistence,
    store: { put },
    retentionMillis: 60_000,
    now: () => new Date('2026-10-02T00:00:00.000Z'),
    spoolDirectory,
    spoolOperations: { openFile, removeDirectory },
  });
  const input = {
    owner: attemptOwner,
    reserved,
    body: chunks(bytes),
    maxBytes: NODE_JSON_LIMITS_V1.bytes,
    signal: new AbortController().signal,
  };
  return {
    writer,
    input,
    bytes,
    reserved,
    events,
    put,
    assertReserved,
    finalize,
    createPending,
    reserve,
    openFile,
    removeDirectory,
    spoolDirectory,
    uploadedBytes: () => uploadedBytes,
  };
}

describe('reserved execution-value artifact writer', () => {
  it.each([attemptOwner, runOwner])(
    'delegates the reserved ID and actual $kind proof without a second pending reservation',
    async (owner) => {
      const h = await harness();
      const uploaded = await h.writer({ ...h.input, owner });
      const { available: _available, ...expected } = h.reserved;
      expect(uploaded).toEqual(expected);
      expect(Object.isFrozen(uploaded)).toBe(true);
      expect(h.uploadedBytes()).toEqual(h.bytes);
      expect(h.events).toEqual(['assert', 'put', 'finalize']);
      expect(h.put).toHaveBeenCalledOnce();
      expect(h.put.mock.calls[0]?.[0]).toMatchObject(expected);
      expect(h.put.mock.calls[0]?.[0].body).toMatchObject({
        destroyed: true,
        closed: true,
      });
      expect(h.assertReserved).toHaveBeenCalledOnce();
      expect(h.finalize).toHaveBeenCalledOnce();
      const proof = h.assertReserved.mock.calls[0]?.[0];
      expect(proof).toEqual({
        owner,
        reserved: h.reserved,
        signal: h.input.signal,
      });
      expect(proof?.owner).toBe(owner);
      expect(proof?.reserved).not.toBe(h.reserved);
      expect(Object.isFrozen(proof?.reserved)).toBe(true);
      expect(h.finalize.mock.calls[0]?.[0]).toBe(proof);
      expect(proof).not.toHaveProperty('expiresAt');
      expect(proof).not.toHaveProperty('purpose');
      expect(h.createPending).not.toHaveBeenCalled();
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.openFile).toHaveBeenCalledOnce();
      expect(h.removeDirectory).toHaveBeenCalledOnce();
      expect(h.removeDirectory.mock.calls[0]?.[0]).toBe(
        path.dirname(h.openFile.mock.calls[0]?.[0] ?? 'missing'),
      );
      expect(await readdir(h.spoolDirectory)).toEqual([]);
    },
  );

  it('rejects an already available reservation without consuming or spooling', async () => {
    const h = await harness();
    const next = vi.fn<AsyncIterator<Uint8Array>['next']>();
    const body = { [Symbol.asyncIterator]: () => ({ next }) };
    await expect(
      h.writer({
        ...h.input,
        reserved: { ...h.reserved, available: true },
        body,
      }),
    ).rejects.toThrow('Execution value reservation is not writable');
    expect(next).not.toHaveBeenCalled();
    expect(h.openFile).not.toHaveBeenCalled();
    expect(h.assertReserved).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
  });

  it.each([{ byteLength: 1 }, { sha256: 'a'.repeat(64) }])(
    'rejects spooled metadata mismatch before protected persistence or put %j',
    async (patch) => {
      const h = await harness();
      await expect(
        h.writer({ ...h.input, reserved: { ...h.reserved, ...patch } }),
      ).rejects.toThrow('Artifact store returned incompatible metadata');
      expect(h.assertReserved).not.toHaveBeenCalled();
      expect(h.put).not.toHaveBeenCalled();
      expect(h.finalize).not.toHaveBeenCalled();
      expect(h.removeDirectory).toHaveBeenCalledOnce();
      expect(await readdir(h.spoolDirectory)).toEqual([]);
    },
  );

  it.each([
    { workspaceId: RUN_ID },
    { mediaType: 'application/json' },
    { byteLength: 0 },
    { byteLength: NODE_JSON_LIMITS_V1.bytes + 1 },
  ])(
    'rejects incompatible owner/format/size metadata before spooling %j',
    async (patch) => {
      const h = await harness();
      await expect(
        h.writer({
          ...h.input,
          reserved: {
            ...h.reserved,
            ...patch,
          } as WorkflowExecutionValueArtifact,
        }),
      ).rejects.toThrow('Execution value reservation is not writable');
      expect(h.openFile).not.toHaveBeenCalled();
      expect(h.assertReserved).not.toHaveBeenCalled();
      expect(h.put).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1, NODE_JSON_LIMITS_V1.bytes + 1, Number.NaN])(
    'rejects invalid maximum %s before IO',
    async (maxBytes) => {
      const h = await harness();
      await expect(h.writer({ ...h.input, maxBytes })).rejects.toThrow(
        'Execution value reservation is not writable',
      );
      expect(h.openFile).not.toHaveBeenCalled();
      expect(h.put).not.toHaveBeenCalled();
    },
  );

  it('requires the actual run-result workspace rather than fabricated attempt context', async () => {
    const h = await harness();
    await expect(
      h.writer({ ...h.input, owner: { ...runOwner, workspaceId: RUN_ID } }),
    ).rejects.toThrow('Execution value reservation is not writable');
    expect(h.put).not.toHaveBeenCalled();
  });

  it('rechecks protected SQL reservation authority after spooling and before put', async () => {
    const h = await harness();
    const refused = new Error('reservation lifecycle changed');
    h.assertReserved.mockRejectedValue(refused);
    await expect(h.writer(h.input)).rejects.toBe(refused);
    expect(h.openFile).toHaveBeenCalledOnce();
    expect(h.put).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
    expect(await readdir(h.spoolDirectory)).toEqual([]);
  });

  it('does not expose or use legacy computed expiry to extend reserved SQL retention', async () => {
    const h = await harness();
    await h.writer(h.input);
    const proof = h.assertReserved.mock.calls[0]?.[0];
    expect(Object.keys(proof ?? {}).sort()).toEqual([
      'owner',
      'reserved',
      'signal',
    ]);
    expect(Object.keys(proof?.reserved ?? {}).sort()).toEqual([
      'artifactId',
      'available',
      'byteLength',
      'mediaType',
      'sha256',
      'workspaceId',
    ]);
    expect(artifactStorageKey(WORKSPACE_ID, artifactId)).toBe(
      `workspaces/${WORKSPACE_ID}/artifacts/${artifactId}`,
    );
  });

  it('keeps finalized reservation identity immutable even if caller metadata changes during proof', async () => {
    const h = await harness();
    const mutable = { ...h.reserved };
    h.assertReserved.mockImplementation(() => {
      mutable.artifactId = RUN_ID;
      mutable.sha256 = 'a'.repeat(64);
      return Promise.resolve();
    });
    await h.writer({ ...h.input, reserved: mutable });
    expect(h.put.mock.calls[0]?.[0].artifactId).toBe(artifactId);
    expect(h.finalize.mock.calls[0]?.[0].reserved).toEqual(h.reserved);
  });

  it('delegates byte-limit failure and producer buffer clearing to the existing writer', async () => {
    const h = await harness();
    const bytes = Buffer.from(h.bytes);
    async function* source() {
      yield await Promise.resolve(bytes);
    }
    await expect(
      h.writer({
        ...h.input,
        reserved: { ...h.reserved, byteLength: 1 },
        maxBytes: 1,
        body: source(),
      }),
    ).rejects.toThrow('Node artifact exceeds its byte limit');
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(h.assertReserved).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    expect(await readdir(h.spoolDirectory)).toEqual([]);
  });

  it('aborts before any callback, source consumption or spool allocation', async () => {
    const h = await harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.writer({ ...h.input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.openFile).not.toHaveBeenCalled();
    expect(h.assertReserved).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
  });

  it('delegates abort during spooling with iterator closure, chunk zeroing and cleanup', async () => {
    const h = await harness();
    const controller = new AbortController();
    const bytes = Buffer.from(h.bytes);
    const closed = vi.fn();
    async function* source() {
      try {
        controller.abort();
        yield await Promise.resolve(bytes);
      } finally {
        closed();
      }
    }
    await expect(
      h.writer({ ...h.input, body: source(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toHaveBeenCalledOnce();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(h.put).not.toHaveBeenCalled();
    expect(await readdir(h.spoolDirectory)).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not upload when cancellation wins during reservation recheck', async () => {
    const h = await harness();
    const controller = new AbortController();
    h.assertReserved.mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    await expect(
      h.writer({ ...h.input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.put).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
    expect(await readdir(h.spoolDirectory)).toEqual([]);
  });

  it('closes upload and skips finalization when cancellation arrives during put', async () => {
    const h = await harness();
    const controller = new AbortController();
    h.put.mockImplementation((input) => {
      controller.abort();
      return Promise.resolve({ ...h.reserved, artifactId: input.artifactId });
    });
    await expect(
      h.writer({ ...h.input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.put.mock.calls[0]?.[0].body).toMatchObject({
      destroyed: true,
      closed: true,
    });
    expect(h.finalize).not.toHaveBeenCalled();
    expect(await readdir(h.spoolDirectory)).toEqual([]);
  });

  it('propagates cancellation during finalization after owned spool cleanup', async () => {
    const h = await harness();
    const controller = new AbortController();
    h.finalize.mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    await expect(
      h.writer({ ...h.input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.finalize).toHaveBeenCalledOnce();
    expect(await readdir(h.spoolDirectory)).toEqual([]);
  });

  it('preserves upload failures and cleanup without finalizing a reservation', async () => {
    const h = await harness();
    const failure = new Error('object-store failure');
    h.put.mockRejectedValue(failure);
    await expect(h.writer(h.input)).rejects.toBe(failure);
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.put.mock.calls[0]?.[0].body).toMatchObject({
      destroyed: true,
      closed: true,
    });
    expect(await readdir(h.spoolDirectory)).toEqual([]);
  });

  it('preserves finalization failures without another upload or reservation', async () => {
    const h = await harness();
    const failure = new Error('finalization failure');
    h.finalize.mockRejectedValue(failure);
    await expect(h.writer(h.input)).rejects.toBe(failure);
    expect(h.put).toHaveBeenCalledOnce();
    expect(h.finalize).toHaveBeenCalledOnce();
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.createPending).not.toHaveBeenCalled();
    expect(await readdir(h.spoolDirectory)).toEqual([]);
  });

  it('delegates uploaded metadata verification before protected finalization', async () => {
    const h = await harness();
    h.put.mockResolvedValue({ ...h.reserved, sha256: 'a'.repeat(64) });
    await expect(h.writer(h.input)).rejects.toThrow(
      'Artifact store returned incompatible metadata',
    );
    expect(h.finalize).not.toHaveBeenCalled();
    expect(await readdir(h.spoolDirectory)).toEqual([]);
  });
});
