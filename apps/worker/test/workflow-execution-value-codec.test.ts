import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import type { ArtifactMetadata } from '@pertexo/artifact-store';
import {
  createDatabaseRuntime,
  createNodeAttemptRunStore,
  prepareInlineWorkflowExecutionValueV3,
  serializeWorkflowExecutionJsonValueV3,
} from '@pertexo/database/execution';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkflowExecutionValueCodec,
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  type WorkflowExecutionValueCodecDependencies,
  type WorkflowExecutionValueProducerOwner,
} from '../src/execution/workflow-execution-value-codec.js';
import {
  lease,
  WORKSPACE_ID,
  RUN_ID,
  VERSION_ID,
  OUTBOX_EVENT_ID,
} from './support/node-attempt-handler.fixture.js';

const artifactId = '88888888-8888-4888-8888-888888888888';
const signal = () => new AbortController().signal;
const owner: WorkflowExecutionValueProducerOwner = Object.freeze({
  kind: 'attempt',
  slot: 'call_input',
  lease: lease(),
});
const artifactRef = { schemaVersion: 1, kind: 'artifact', artifactId };
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
function metadata(bytes: Buffer): ArtifactMetadata {
  return {
    artifactId,
    workspaceId: WORKSPACE_ID,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  };
}
function harness(initial?: Buffer) {
  let bytes =
    initial === undefined ? Buffer.from('null') : Buffer.from(initial);
  let descriptor = metadata(bytes);
  let available = false;
  let lastBody: Readable | undefined;
  const reserve = vi.fn<WorkflowExecutionValueCodecDependencies['reserve']>(
    (input) => {
      descriptor = {
        ...descriptor,
        byteLength: input.byteLength,
        sha256: input.sha256,
        mediaType: input.mediaType,
      };
      return Promise.resolve({ ...descriptor, available });
    },
  );
  const writeReserved = vi.fn<
    WorkflowExecutionValueCodecDependencies['writeReserved']
  >(async (input) => {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    bytes = Buffer.concat(chunks);
    available = true;
    return { ...descriptor };
  });
  const authorize = vi.fn<WorkflowExecutionValueCodecDependencies['authorize']>(
    () => Promise.resolve({ ...descriptor, available: true }),
  );
  const getStream = vi.fn<
    WorkflowExecutionValueCodecDependencies['store']['getStream']
  >(() => {
    lastBody = Readable.from([
      Buffer.from(bytes.subarray(0, 3)),
      Buffer.from(bytes.subarray(3)),
    ]);
    return Promise.resolve({ body: lastBody, metadata: { ...descriptor } });
  });
  const chooseInline = vi.fn(prepareInlineWorkflowExecutionValueV3);
  const dependencies = {
    chooseInline,
    reserve,
    writeReserved,
    authorize,
    store: { getStream },
  };
  return {
    dependencies,
    codec: createWorkflowExecutionValueCodec(dependencies),
    reserve,
    writeReserved,
    authorize,
    getStream,
    chooseInline,
    body: () => lastBody,
    bytes: () => bytes,
    descriptor: () => descriptor,
  };
}

describe('framework execution value codec', () => {
  it('rechecks an uploaded candidate without requiring accepted-source authorization before acceptance', async () => {
    const h = harness();
    h.authorize.mockRejectedValue(
      new Error('Candidate has no accepted provenance'),
    );
    await expect(
      h.codec.prepare({ owner, value: 'x'.repeat(300_000), signal: signal() }),
    ).resolves.toMatchObject({ reference: artifactRef });
    expect(h.reserve).toHaveBeenCalledTimes(2);
    expect(h.reserve.mock.calls[1]?.[0]).toBe(h.reserve.mock.calls[0]?.[0]);
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it('requires an explicit attempt producer slot before choosing a representation', async () => {
    const h = harness();
    await expect(
      h.codec.prepare({
        owner: {
          kind: 'attempt',
          lease: lease(),
        } as unknown as WorkflowExecutionValueProducerOwner,
        value: 'ordinary input',
        signal: signal(),
      }),
    ).rejects.toThrow('Execution value producer slot is required');
    expect(h.chooseInline).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it('requires distinct pre-CAS and post-CAS result revisions before preparation', async () => {
    const h = harness();
    await expect(
      h.codec.prepare({
        owner: {
          kind: 'run_result',
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          workflowVersionId: VERSION_ID,
          expectedRevision: 4,
          resultRevision: 4,
          resultIdentity: 'b'.repeat(64),
          delivery: {
            outboxEventId: OUTBOX_EVENT_ID,
            payloadChecksum: 'a'.repeat(64),
          },
        },
        value: 'result',
        signal: signal(),
      }),
    ).rejects.toThrow('Execution value result producer identity is invalid');
    expect(h.chooseInline).not.toHaveBeenCalled();
  });
  it('round-trips producer bytes through actual record/read adapters and hydration (mocked SQL, not role proof)', async () => {
    const config = parseDatabaseConfig({
      connectionString:
        'postgresql://pertexo_worker:unused@invalid.invalid/pertexo',
      max: 1,
    });
    let scoped = false;
    let snapshot: unknown = null;
    const recordedBytes: string[] = [];
    const query = vi.fn((sql: string, args?: readonly unknown[]) => {
      if (sql.includes("set_config('app.workspace_id'")) scoped = true;
      if (sql === 'commit' || sql === 'rollback') scoped = false;
      if (sql.includes('current_setting'))
        return Promise.resolve({
          rows: [
            {
              workspace_id: scoped ? WORKSPACE_ID : null,
              actor_id: null,
              discovery_scope: null,
            },
          ],
        });
      if (sql.includes('app.record_workflow_call_declaration_input')) {
        const [, reference, sha, bytes, serialized] = args ?? [];
        recordedBytes.push(serialized as string);
        snapshot = {
          reference: JSON.parse(reference as string) as unknown,
          sha256: sha,
          byteLength: bytes,
          serializedValue: serialized,
        };
      }
      if (sql.includes('app.read_workflow_call_declaration_input'))
        return Promise.resolve({ rows: [{ snapshot }] });
      return Promise.resolve({ rows: [] });
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const checkout = vi
      .spyOn(Pool.prototype, 'connect')
      .mockReturnValue(Promise.resolve(client) as never);
    const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
    const store = createNodeAttemptRunStore(config, runtime);
    try {
      if (
        store.recordCallDeclarationInput === undefined ||
        store.readCallDeclarationInput === undefined
      )
        throw new Error('Required Call input adapters are missing');
      const h = harness();
      const values = [
        { '2': 'two', '10': 'ten', nested: { '2': -0, '10': '界😀\n\t"\\' } },
        [Number.MIN_VALUE, Number.MAX_VALUE, 1e-7, 1e-6, 1e20, 1e21, -0],
      ];
      for (const value of values) {
        const prepared = await h.codec.prepare({
          owner,
          value,
          signal: signal(),
        });
        await store.recordCallDeclarationInput({
          lease: owner.lease,
          ...prepared,
          signal: signal(),
        });
        const recovered = await store.readCallDeclarationInput({
          lease: { ...owner.lease, fenceToken: owner.lease.fenceToken + 1 },
          signal: signal(),
        });
        expect(recovered).toEqual({
          ...prepared,
          serializedValue: recordedBytes.at(-1),
        });
        if (recovered === undefined)
          throw new Error('Committed Call input is missing');
        const hydrated = await h.codec.hydrate({
          owner,
          reference: recovered.reference,
          signal: signal(),
        });
        const bytes = serializeWorkflowExecutionJsonValueV3(hydrated);
        expect(recordedBytes.at(-1)).toBe(bytes);
        expect(sha256(Buffer.from(bytes))).toBe(prepared.sha256);
      }
      expect(release).toHaveBeenCalledTimes(values.length * 2);
      expect(h.reserve).not.toHaveBeenCalled();
    } finally {
      checkout.mockRestore();
      await store.close();
      await runtime.close();
    }
  });
  it.each([false, true])(
    'uses persisted-value byte order through prepare and hydrate (artifact=%s)',
    async (artifact) => {
      const h = harness();
      if (artifact) h.chooseInline.mockReturnValue(undefined);
      const value = {
        '2': 'two',
        '10': 'ten',
        nested: {
          '2': -0,
          '10': [Number.MIN_VALUE, Number.MAX_VALUE, 1e-7, 1e-6, 1e20, 1e21],
        },
        text: '界😀\n\t"\\',
      };
      const expected =
        '{"10":"ten","2":"two","nested":{"10":[5e-324,1.7976931348623157e+308,1e-7,0.000001,100000000000000000000,1e+21],"2":0},"text":"界😀\\n\\t\\"\\\\"}';
      const prepared = await h.codec.prepare({
        owner,
        value,
        signal: signal(),
      });
      expect(prepared.reference.kind).toBe(artifact ? 'artifact' : 'inline');
      expect(prepared.sha256).toBe(sha256(Buffer.from(expected)));
      expect(prepared.byteLength).toBe(Buffer.byteLength(expected));
      if (artifact) expect(h.bytes().toString()).toBe(expected);
      const hydrated = await h.codec.hydrate({
        owner,
        reference: prepared.reference,
        signal: signal(),
      });
      expect(serializeWorkflowExecutionJsonValueV3(hydrated)).toBe(expected);
    },
  );
  it('keeps inline values IO-free and independently normalized/frozen', async () => {
    const h = harness();
    const value = { z: [1, -0], a: 'small' };
    const prepared = await h.codec.prepare({ owner, value, signal: signal() });
    expect(prepared.reference.kind).toBe('inline');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.reference)).toBe(true);
    const hydrated = await h.codec.hydrate({
      owner,
      reference: prepared.reference,
      signal: signal(),
    });
    expect(hydrated).toEqual({ a: 'small', z: [1, 0] });
    expect(Object.isFrozen(hydrated)).toBe(true);
    value.z.push(10);
    expect(hydrated).not.toEqual(value);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.writeReserved).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.getStream).not.toHaveBeenCalled();
  });
  it('preserves the 256KiB inline limit and spills one byte beyond it', async () => {
    const h = harness();
    const overhead = Buffer.byteLength(
      JSON.stringify({ kind: 'inline', schemaVersion: 1, value: '' }),
    );
    expect(
      (
        await h.codec.prepare({
          owner,
          value: 'x'.repeat(262_144 - overhead),
          signal: signal(),
        })
      ).reference.kind,
    ).toBe('inline');
    expect(
      (
        await h.codec.prepare({
          owner,
          value: 'x'.repeat(262_144 - overhead + 1),
          signal: signal(),
        })
      ).reference.kind,
    ).toBe('artifact');
    expect(h.reserve).toHaveBeenCalledTimes(2);
  });
  it('spills and hydrates exactly 1MiB source JSON without envelope overhead', async () => {
    const h = harness();
    const value = 'x'.repeat(NODE_JSON_LIMITS_V1.bytes - 2);
    const prepared = await h.codec.prepare({ owner, value, signal: signal() });
    expect(prepared.reference).toEqual(artifactRef);
    expect(prepared.byteLength).toBe(NODE_JSON_LIMITS_V1.bytes);
    expect(prepared.sha256).toBe(
      sha256(Buffer.from(serializeWorkflowExecutionJsonValueV3(value))),
    );
    expect(h.writeReserved.mock.calls[0]?.[0].owner).toBe(owner);
    expect(h.writeReserved.mock.calls[0]?.[0].maxBytes).toBe(
      NODE_JSON_LIMITS_V1.bytes,
    );
    expect(
      await h.codec.hydrate({
        owner,
        reference: prepared.reference,
        signal: signal(),
      }),
    ).toBe(value);
    expect(h.body()?.destroyed).toBe(true);
    expect(h.authorize).toHaveBeenCalledTimes(1);
  });
  it('passes actual coordinator delivery proof and revision for run result ownership', async () => {
    const h = harness();
    const runOwner: WorkflowExecutionValueProducerOwner = {
      kind: 'run_result',
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      workflowVersionId: VERSION_ID,
      expectedRevision: 3,
      resultRevision: 4,
      resultIdentity: 'b'.repeat(64),
      delivery: {
        outboxEventId: OUTBOX_EVENT_ID,
        payloadChecksum: 'a'.repeat(64),
      },
    };
    await h.codec.prepare({
      owner: runOwner,
      value: 'x'.repeat(300_000),
      signal: signal(),
    });
    expect(h.reserve.mock.calls[0]?.[0].owner).toBe(runOwner);
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    'x'.repeat(NODE_JSON_LIMITS_V1.bytes - 1),
  ])('rejects invalid or oversized input before storage %j', async (value) => {
    const h = harness();
    await expect(
      h.codec.prepare({ owner, value, signal: signal() }),
    ).rejects.toThrow(/bounded JSON/);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.chooseInline).not.toHaveBeenCalled();
  });
  it('rejects getter/cycle/proxy input before reserve without leaking diagnostics', async () => {
    const h = harness();
    const getter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        throw new Error('secret token');
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let touched = false;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          touched = true;
          throw new Error('secret');
        },
      },
    );
    for (const value of [getter, cyclic, proxy])
      await expect(
        h.codec.prepare({ owner, value, signal: signal() }),
      ).rejects.toThrow('Execution value is not bounded JSON');
    expect(touched).toBe(false);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it('spills SDK-valid NUL strings which retained inline owner rejects', async () => {
    const h = harness();
    expect(
      (await h.codec.prepare({ owner, value: '\u0000', signal: signal() }))
        .reference.kind,
    ).toBe('artifact');
    expect(
      await h.codec.hydrate({
        owner,
        reference: artifactRef,
        signal: signal(),
      }),
    ).toBe('\u0000');
  });
  it('reuses available reservation without writing or recharging', async () => {
    const value = 'x'.repeat(300_000);
    const h = harness(
      Buffer.from(serializeWorkflowExecutionJsonValueV3(value)),
    );
    h.reserve.mockResolvedValue({ ...h.descriptor(), available: true });
    expect(
      (await h.codec.prepare({ owner, value, signal: signal() })).reference,
    ).toEqual(artifactRef);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.writeReserved).not.toHaveBeenCalled();
    expect(h.getStream).not.toHaveBeenCalled();
  });
  it.each([
    { workspaceId: RUN_ID },
    { artifactId: 'invalid' },
    { byteLength: 1 },
    { sha256: 'b'.repeat(64) },
    { mediaType: 'application/json' },
    { extra: true },
  ])('rejects incompatible reservation before write %j', async (patch) => {
    const h = harness();
    h.reserve.mockImplementation((input) =>
      Promise.resolve({
        ...metadata(Buffer.from('null')),
        byteLength: input.byteLength,
        sha256: input.sha256,
        available: false,
        ...patch,
      }),
    );
    await expect(
      h.codec.prepare({ owner, value: 'x'.repeat(300_000), signal: signal() }),
    ).rejects.toThrow();
    expect(h.writeReserved).not.toHaveBeenCalled();
  });
  it('rejects writer mismatches and requires post-write candidate availability proof', async () => {
    const h = harness();
    h.writeReserved.mockImplementation(() =>
      Promise.resolve({
        ...h.descriptor(),
        sha256: 'b'.repeat(64),
      }),
    );
    await expect(
      h.codec.prepare({ owner, value: 'x'.repeat(300_000), signal: signal() }),
    ).rejects.toThrow(/integrity/);
    const unavailable = harness();
    const initialReservation = unavailable.reserve.getMockImplementation();
    if (initialReservation === undefined)
      throw new Error('Reservation adapter is missing');
    unavailable.reserve
      .mockImplementationOnce(initialReservation)
      .mockImplementation((input) =>
        Promise.resolve({
          ...unavailable.descriptor(),
          byteLength: input.byteLength,
          sha256: input.sha256,
          available: false,
        }),
      );
    await expect(
      unavailable.codec.prepare({
        owner,
        value: 'x'.repeat(300_000),
        signal: signal(),
      }),
    ).rejects.toThrow(/unavailable/);
  });
  it.each([
    { artifactId: '99999999-9999-4999-8999-999999999999' },
    { workspaceId: RUN_ID },
    { byteLength: 1 },
    { sha256: 'b'.repeat(64) },
    { mediaType: 'application/json' },
  ])(
    'fails preparation when the candidate recheck disagrees %j',
    async (patch) => {
      const h = harness();
      const initialReservation = h.reserve.getMockImplementation();
      if (initialReservation === undefined)
        throw new Error('Reservation adapter is missing');
      h.reserve
        .mockImplementationOnce(initialReservation)
        .mockImplementation(() =>
          Promise.resolve({ ...h.descriptor(), available: true, ...patch }),
        );
      await expect(
        h.codec.prepare({
          owner,
          value: 'x'.repeat(300_000),
          signal: signal(),
        }),
      ).rejects.toThrow();
      expect(h.writeReserved).toHaveBeenCalledOnce();
      expect(h.reserve).toHaveBeenCalledTimes(2);
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.getStream).not.toHaveBeenCalled();
    },
  );
  it('clears the producer-owned copy even if a writer abandons its iterator', async () => {
    const h = harness();
    let chunk: Uint8Array | undefined;
    h.writeReserved.mockImplementation(async (input) => {
      const first = await input.body[Symbol.asyncIterator]().next();
      if (!first.done) chunk = first.value;
      throw new Error('write failed');
    });
    await expect(
      h.codec.prepare({ owner, value: 'x'.repeat(300_000), signal: signal() }),
    ).rejects.toThrow('write failed');
    expect(chunk?.every((byte) => byte === 0)).toBe(true);
  });
  it.each([
    { workspaceId: RUN_ID },
    { artifactId: RUN_ID },
    { mediaType: 'application/json' },
    { available: false },
    { byteLength: NODE_JSON_LIMITS_V1.bytes + 1 },
    { sha256: 'A'.repeat(64) },
  ])(
    'authorizes provenance and format before any artifact stream %j',
    async (patch) => {
      const h = harness();
      h.authorize.mockResolvedValue({
        ...h.descriptor(),
        available: true,
        ...patch,
      });
      await expect(
        h.codec.hydrate({ owner, reference: artifactRef, signal: signal() }),
      ).rejects.toThrow();
      expect(h.getStream).not.toHaveBeenCalled();
    },
  );
  it.each([
    { workspaceId: RUN_ID },
    { artifactId: RUN_ID },
    { byteLength: 3 },
    { sha256: 'a'.repeat(64) },
    { mediaType: 'application/json' },
  ])('destroys returned stream on metadata mismatch %j', async (patch) => {
    const h = harness();
    const body = Readable.from([Buffer.from('null')]);
    h.getStream.mockResolvedValue({
      body,
      metadata: { ...h.descriptor(), ...patch },
    });
    await expect(
      h.codec.hydrate({ owner, reference: artifactRef, signal: signal() }),
    ).rejects.toThrow();
    expect(body.destroyed).toBe(true);
  });
  it.each([Buffer.from('nul'), Buffer.from('nullEXTRA'), Buffer.from('true')])(
    'rejects truncation/overflow/byte digest mismatch and cleans stream',
    async (bytes) => {
      const h = harness();
      const body = Readable.from([Buffer.from(bytes)]);
      h.getStream.mockResolvedValue({ body, metadata: h.descriptor() });
      const controller = new AbortController();
      await expect(
        h.codec.hydrate({
          owner,
          reference: artifactRef,
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(body.destroyed).toBe(true);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    },
  );
  it.each([
    Buffer.from([0x22, 0xff, 0x22]),
    Buffer.from('{'),
    Buffer.from(' {"a":1} '),
    Buffer.from('{"z":1,"a":2}'),
    Buffer.from('{"a":1,"a":2}'),
    Buffer.from('-0'),
  ])(
    'rejects invalid UTF8/JSON or noncanonical JSON with otherwise matching byte metadata',
    async (bytes) => {
      const h = harness(bytes);
      await expect(
        h.codec.hydrate({ owner, reference: artifactRef, signal: signal() }),
      ).rejects.toThrow();
      expect(h.body()?.destroyed).toBe(true);
    },
  );
  it('rejects hostile references and metadata without invoking getter/proxy traps', async () => {
    const h = harness();
    let touched = false;
    const reference = Object.defineProperty(
      { schemaVersion: 1, kind: 'artifact' },
      'artifactId',
      {
        enumerable: true,
        get() {
          touched = true;
          return artifactId;
        },
      },
    );
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          touched = true;
          throw new Error('secret');
        },
      },
    );
    for (const ref of [reference, proxy, { ...artifactRef, extra: true }])
      await expect(
        h.codec.hydrate({ owner, reference: ref, signal: signal() }),
      ).rejects.toThrow();
    h.authorize.mockResolvedValue(proxy);
    await expect(
      h.codec.hydrate({ owner, reference: artifactRef, signal: signal() }),
    ).rejects.toThrow();
    const meta = Object.defineProperty(
      { ...h.descriptor(), available: true },
      'sha256',
      {
        enumerable: true,
        get() {
          touched = true;
          throw new Error('secret');
        },
      },
    );
    h.authorize.mockResolvedValue(meta);
    await expect(
      h.codec.hydrate({ owner, reference: artifactRef, signal: signal() }),
    ).rejects.toThrow();
    expect(touched).toBe(false);
    expect(h.getStream).not.toHaveBeenCalled();
  });
  it('aborts before callbacks and destroys an idle in-flight stream promptly', async () => {
    const h = harness();
    const early = new AbortController();
    early.abort();
    await expect(
      h.codec.prepare({ owner, value: {}, signal: early.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      h.codec.hydrate({ owner, reference: artifactRef, signal: early.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
    const controller = new AbortController();
    const body = new Readable({
      read() {
        /* Deliberately idle until canceled. */
      },
    });
    h.getStream.mockImplementation(() => {
      queueMicrotask(() => {
        controller.abort();
      });
      return Promise.resolve({ body, metadata: h.descriptor() });
    });
    await expect(
      h.codec.hydrate({
        owner,
        reference: artifactRef,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(body.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
  it('aborts during byte consumption and clears consumed byte buffers', async () => {
    const h = harness();
    const controller = new AbortController();
    const chunk = Buffer.from('nu');
    async function* source() {
      yield await Promise.resolve(chunk);
      controller.abort();
      yield Buffer.from('ll');
    }
    const body = Readable.from(source());
    h.getStream.mockResolvedValue({ body, metadata: h.descriptor() });
    await expect(
      h.codec.hydrate({
        owner,
        reference: artifactRef,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(body.destroyed).toBe(true);
    expect(chunk.every((byte) => byte === 0)).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
  it('rejects hidden metadata fields and custom-prototype inline references', async () => {
    const h = harness();
    const hidden = Object.defineProperty(
      { ...h.descriptor(), available: true },
      'extra',
      { value: true },
    );
    h.authorize.mockResolvedValue(hidden);
    await expect(
      h.codec.hydrate({ owner, reference: artifactRef, signal: signal() }),
    ).rejects.toThrow(/metadata/);
    const inherited: unknown = Object.assign(
      Object.create({ extra: true }) as object,
      { schemaVersion: 1, kind: 'inline', value: 1 },
    );
    await expect(
      h.codec.hydrate({ owner, reference: inherited, signal: signal() }),
    ).rejects.toThrow(/reference/);
    expect(h.getStream).not.toHaveBeenCalled();
  });
  it('honors SDK depth/member bounds before representation selection', async () => {
    const h = harness();
    let deep: unknown = null;
    for (let i = 0; i < 65; i++) deep = [deep];
    for (const value of [deep, Array.from({ length: 10_001 }, () => 1)])
      await expect(
        h.codec.prepare({ owner, value, signal: signal() }),
      ).rejects.toThrow(/bounded JSON/);
    expect(h.chooseInline).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it('rejects changed inline callback value without creating an artifact', async () => {
    const h = harness();
    h.chooseInline.mockReturnValue({
      schemaVersion: 1,
      kind: 'inline',
      value: 'different',
    });
    await expect(
      h.codec.prepare({ owner, value: 'expected', signal: signal() }),
    ).rejects.toThrow(/does not match/);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it('stops after aborted reservation, and clears a chunk when abort happens during writing', async () => {
    const h = harness();
    const controller = new AbortController();
    h.reserve.mockImplementation((input) => {
      controller.abort();
      return Promise.resolve({
        ...h.descriptor(),
        byteLength: input.byteLength,
        sha256: input.sha256,
        available: false,
      });
    });
    await expect(
      h.codec.prepare({
        owner,
        value: 'x'.repeat(300_000),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.writeReserved).not.toHaveBeenCalled();
    const writing = harness();
    const writeController = new AbortController();
    let chunk: Uint8Array | undefined;
    writing.writeReserved.mockImplementation(async (input) => {
      const result = await input.body[Symbol.asyncIterator]().next();
      if (!result.done) chunk = result.value;
      writeController.abort();
      return writing.descriptor();
    });
    await expect(
      writing.codec.prepare({
        owner,
        value: 'x'.repeat(300_000),
        signal: writeController.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunk?.every((byte) => byte === 0)).toBe(true);
    expect(writing.authorize).not.toHaveBeenCalled();
    expect(getEventListeners(writeController.signal, 'abort')).toHaveLength(0);
  });
  it.each(['x'.repeat(262_144 - 1), '\u0000'])(
    'rejects retained-inline-invalid references without spilling or IO',
    async (value) => {
      const h = harness();
      await expect(
        h.codec.hydrate({
          owner,
          reference: { schemaVersion: 1, kind: 'inline', value },
          signal: signal(),
        }),
      ).rejects.toThrow(/retained inline/);
      h.chooseInline.mockReturnValue({
        schemaVersion: 1,
        kind: 'inline',
        value,
      });
      await expect(
        h.codec.prepare({ owner, value, signal: signal() }),
      ).rejects.toThrow(/retained inline/);
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.writeReserved).not.toHaveBeenCalled();
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.getStream).not.toHaveBeenCalled();
    },
  );
  it('rejects over-keyed, hidden and accessor reference envelopes before IO', async () => {
    const h = harness();
    let touched = false;
    const accessor = Object.defineProperty(
      { schemaVersion: 1, kind: 'inline' },
      'value',
      {
        enumerable: true,
        get() {
          touched = true;
          return 1;
        },
      },
    );
    const hidden = Object.defineProperty(
      { schemaVersion: 1, kind: 'inline', value: 1 },
      'extra',
      { value: true },
    );
    const oversized = {
      ...artifactRef,
      ...Object.fromEntries(
        Array.from({ length: 10_000 }, (_, i) => [`extra${String(i)}`, 1]),
      ),
    };
    for (const reference of [accessor, hidden, oversized])
      await expect(
        h.codec.hydrate({ owner, reference, signal: signal() }),
      ).rejects.toThrow(/reference/);
    expect(touched).toBe(false);
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.getStream).not.toHaveBeenCalled();
  });
  it('rejects metadata key overflows before reading accessors or artifact IO', async () => {
    const h = harness();
    let touched = false;
    const oversized = {
      ...h.descriptor(),
      available: true,
      ...Object.fromEntries(
        Array.from({ length: 10_000 }, (_, i) => [`extra${String(i)}`, 1]),
      ),
    };
    Object.defineProperty(oversized, 'sha256', {
      enumerable: true,
      get() {
        touched = true;
        throw new Error('secret');
      },
    });
    h.authorize.mockResolvedValue(oversized);
    await expect(
      h.codec.hydrate({ owner, reference: artifactRef, signal: signal() }),
    ).rejects.toThrow(/metadata/);
    expect(touched).toBe(false);
    expect(h.getStream).not.toHaveBeenCalled();
    const hidden = Object.defineProperty(
      { ...h.descriptor(), available: true },
      'available',
      { enumerable: false, value: true },
    );
    h.authorize.mockResolvedValue(hidden);
    await expect(
      h.codec.hydrate({ owner, reference: artifactRef, signal: signal() }),
    ).rejects.toThrow(/metadata/);
    expect(h.getStream).not.toHaveBeenCalled();
  });
});
