import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import type { WorkspaceInboxCaptureInput } from '../src/execution/workspace-inbox/capture-contract.js';

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  readiness: vi.fn(),
}));
vi.mock('../src/platform/database-runtime.js', () => ({
  acquireDatabasePool: () => ({
    pool: { connect: database.connect },
    close: database.close,
  }),
}));
vi.mock('../src/execution/workspace-inbox/capture-readiness.js', () => ({
  checkInboxCaptureReadiness: database.readiness,
}));
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input: WorkspaceInboxCaptureInput = {
  workspaceId,
  sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workerId: 'capture-test',
  delivery: {
    outboxEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    payloadChecksum: 'a'.repeat(64),
  },
  signal: new AbortController().signal,
};
const config = parseDatabaseConfig({
  connectionString: 'postgresql://worker@fixture.invalid/disposable',
});

function client(
  result: unknown,
  options: Readonly<{
    command?: () => Promise<unknown>;
    commit?: () => Promise<void>;
    deferEnd?: boolean;
  }> = {},
) {
  const query = vi.fn(async (text: string) => {
    if (text.includes('from pg_settings'))
      return {
        rows: [
          {
            workspace: workspaceId,
            lock_millis: '1000',
            statement_millis: '5000',
          },
        ],
      };
    if (text.startsWith('select app.'))
      return {
        rows: [
          {
            result:
              options.command === undefined ? result : await options.command(),
          },
        ],
      };
    if (text === 'commit') await options.commit?.();
    if (text.includes("set_config('app.workspace_id'"))
      return {
        rows: [
          {
            workspace: workspaceId,
            lock_timeout: '1000ms',
            statement_timeout: '5000ms',
          },
        ],
      };
    return { rows: [{ workspace: null, actor: null, discovery: null }] };
  });
  const release = vi.fn();
  const events = new EventEmitter();
  const end = () => events.emit('end');
  const destroy = vi.fn(() => {
    if (!options.deferEnd) queueMicrotask(end);
  });
  return Object.assign(events, {
    query,
    release,
    end,
    connection: { stream: { destroy } },
  });
}
async function factory() {
  const { createWorkspaceInboxCaptureStore } =
    await import('../src/execution/workspace-inbox/capture-store.js');
  return () => createWorkspaceInboxCaptureStore(config);
}
function queueClients(...clients: ReturnType<typeof client>[]) {
  for (const next of clients) database.connect.mockResolvedValueOnce(next);
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  database.close.mockResolvedValue(undefined);
  database.readiness.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('inactive inbox capture store ownership (mocked PostgreSQL)', () => {
  it('owns claim and capture in separate commits without leaking a lease', async () => {
    const claim = client({ kind: 'owned', fenceToken: '9007199254740993' });
    const capture = client({ kind: 'captured', audienceCount: '104' });
    queueClients(claim, capture);
    const store = (await factory())();
    await expect(store.capture(input)).resolves.toEqual({
      kind: 'captured',
      audienceCount: '104',
    });
    expect(claim.query.mock.calls.map(([s]) => s)).toContain('commit');
    expect(capture.query).toHaveBeenCalledWith(
      'select app.capture_workspace_inbox_audience($1,$2,$3,$4) result',
      expect.arrayContaining(['9007199254740993']),
    );
    expect(capture.release).toHaveBeenCalledOnce();
    await store.whenIdle();
    await store.close();
  });
  it.each([
    'unavailable',
    'inactive',
    'expired',
    'blocked',
    'busy',
    'not_due',
    'retry_scheduled',
  ] as const)('does not capture a %s claim', async (kind) => {
    queueClients(client({ kind }));
    const store = (await factory())();
    await expect(store.capture(input)).resolves.toEqual({ kind });
    expect(database.connect).toHaveBeenCalledOnce();
    await store.close();
  });
  it('reconciles a captured marker without another audience statement', async () => {
    queueClients(client({ kind: 'captured', audienceCount: '0' }));
    const store = (await factory())();
    await expect(store.capture(input)).resolves.toEqual({
      kind: 'captured',
      audienceCount: '0',
    });
    expect(database.connect).toHaveBeenCalledOnce();
    await store.close();
  });
  it('rejects invalid identity/signal/checksum before checkout', async () => {
    const store = (await factory())();
    await expect(
      store.capture({ ...input, workspaceId: 'invalid' }),
    ).rejects.toThrow();
    await expect(
      store.capture({
        ...input,
        delivery: { ...input.delivery, payloadChecksum: 'secret' },
      }),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.capture({ ...input, signal: controller.signal }),
    ).rejects.toThrow();
    expect(database.connect).not.toHaveBeenCalled();
    await store.close();
  });
  it('enforces one process admission across stores and direct concurrent callers', async () => {
    const pending = Promise.withResolvers<unknown>();
    queueClients(
      client({ kind: 'owned', fenceToken: '1' }),
      client(undefined, { command: () => pending.promise }),
    );
    const create = await factory();
    const first = create();
    const second = create();
    const started = first.capture(input);
    await vi.waitFor(() => {
      expect(database.connect).toHaveBeenCalledTimes(2);
    });
    await expect(second.capture(input)).resolves.toEqual({ kind: 'busy' });
    await expect(first.capture(input)).resolves.toEqual({ kind: 'busy' });
    pending.resolve({ kind: 'captured', audienceCount: '2' });
    await started;
    await first.whenIdle();
    queueClients(client({ kind: 'captured', audienceCount: '2' }));
    await expect(second.capture(input)).resolves.toEqual({
      kind: 'captured',
      audienceCount: '2',
    });
    await first.close();
    await second.close();
  });
  it('records a known rollback separately, fenced to the original claim', async () => {
    const capture = client(undefined, {
      command: () => Promise.reject(new Error('statement timeout')),
    });
    const failure = client({ kind: 'retry_scheduled' });
    queueClients(client({ kind: 'owned', fenceToken: '9' }), capture, failure);
    const store = (await factory())();
    await expect(store.capture(input)).resolves.toEqual({
      kind: 'retry_scheduled',
    });
    expect(capture.query.mock.calls.map(([s]) => s)).toContain('rollback');
    expect(failure.query).toHaveBeenCalledWith(
      'select app.fail_workspace_inbox_capture($1,$2,$3,$4) result',
      expect.arrayContaining(['9']),
    );
    await store.close();
  });
  it.each(['claim', 'capture'] as const)(
    'does not account or replay a lost %s COMMIT acknowledgement',
    async (phase) => {
      const lost = client(
        {
          kind: phase === 'claim' ? 'owned' : 'captured',
          ...(phase === 'claim' ? { fenceToken: '1' } : { audienceCount: '2' }),
        },
        { commit: () => Promise.reject(new Error('ack lost')) },
      );
      if (phase === 'capture')
        queueClients(client({ kind: 'owned', fenceToken: '1' }));
      queueClients(lost);
      const store = (await factory())();
      await expect(store.capture(input)).resolves.toEqual({
        kind: 'outcome_unknown',
      });
      expect(database.connect).toHaveBeenCalledTimes(phase === 'claim' ? 1 : 2);
      expect(lost.release).toHaveBeenCalledWith(expect.any(Error));
      expect(lost.connection.stream.destroy).toHaveBeenCalledOnce();
      queueClients(client({ kind: 'captured', audienceCount: '2' }));
      await expect(store.capture(input)).resolves.toEqual({
        kind: 'captured',
        audienceCount: '2',
      });
      await store.close();
    },
  );
  it('does not treat a rejected rollback as known failure', async () => {
    const failed = client(undefined, {
      command: () => Promise.reject(new Error('connection lost')),
    });
    const usual = failed.query.getMockImplementation();
    failed.query.mockImplementation(async (text) => {
      if (text === 'rollback') throw new Error('rollback lost');
      return usual?.(text) ?? { rows: [] };
    });
    queueClients(client({ kind: 'owned', fenceToken: '1' }), failed);
    const store = (await factory())();
    await expect(store.capture(input)).resolves.toEqual({
      kind: 'outcome_unknown',
    });
    expect(database.connect).toHaveBeenCalledTimes(2);
    await store.close();
  });
  it.each(['commit', 'rollback', 'abort'] as const)(
    'retains process admission after local %s rejection until driver end is observed',
    async (phase) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const pending = Promise.withResolvers<unknown>();
      const failed = client(
        { kind: 'captured', audienceCount: '1' },
        {
          deferEnd: true,
          ...(phase === 'commit'
            ? { commit: () => Promise.reject(new Error('COMMIT read timeout')) }
            : { command: () => pending.promise }),
        },
      );
      if (phase === 'rollback') {
        const usual = failed.query.getMockImplementation();
        failed.query.mockImplementation(async (text) => {
          if (text === 'rollback') throw new Error('ROLLBACK read timeout');
          return usual?.(text) ?? { rows: [] };
        });
      }
      queueClients(client({ kind: 'owned', fenceToken: '1' }), failed);
      const create = await factory();
      const store = create();
      const other = create();
      const started = store.capture({ ...input, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      if (phase === 'abort') controller.abort();
      if (phase !== 'commit') pending.reject(new Error('local query rejected'));
      await vi.advanceTimersByTimeAsync(0);
      queueClients(client({ kind: 'captured', audienceCount: '1' }));
      await expect(other.capture(input)).resolves.toEqual({ kind: 'busy' });
      expect(failed.connection.stream.destroy).toHaveBeenCalledOnce();
      expect(database.connect).toHaveBeenCalledTimes(2);
      failed.end();
      await expect(started).resolves.toEqual({ kind: 'outcome_unknown' });
      await expect(other.capture(input)).resolves.toEqual({
        kind: 'captured',
        audienceCount: '1',
      });
      await store.close();
      await other.close();
    },
  );
  it('quarantines locally settled COMMIT uncertainty when connection end is not confirmed in time', async () => {
    vi.useFakeTimers();
    const failed = client(
      { kind: 'owned', fenceToken: '1' },
      {
        commit: () => Promise.reject(new Error('COMMIT read timeout')),
        deferEnd: true,
      },
    );
    queueClients(failed);
    const store = (await factory())();
    const started = store.capture(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await started).toBeInstanceOf(Error);
    await expect(store.checkReadiness()).rejects.toThrow('unavailable');
    await expect(store.capture(input)).rejects.toThrow('unavailable');
    failed.end();
    await store.whenIdle();
    // Late closure does not silently restore a quarantined process.
    await expect(store.capture(input)).rejects.toThrow('unavailable');
    await store.close();
  });
  it('recognizes a driver that ended before its rejected COMMIT was observed', async () => {
    const failed = Object.assign(
      client(
        { kind: 'owned', fenceToken: '1' },
        {
          commit: () => Promise.reject(new Error('COMMIT read timeout')),
          deferEnd: true,
        },
      ),
      { _ended: true },
    );
    queueClients(failed);
    const store = (await factory())();
    await expect(store.capture(input)).resolves.toEqual({
      kind: 'outcome_unknown',
    });
    expect(failed.listenerCount('end')).toBe(0);
    await store.checkReadiness();
    await store.close();
  });
  it('waits for driver disposal before dispatching acknowledged-rollback failure accounting', async () => {
    vi.useFakeTimers();
    const failed = client(undefined, {
      command: () => Promise.reject(new Error('statement timeout')),
      deferEnd: true,
    });
    queueClients(
      client({ kind: 'owned', fenceToken: '1' }),
      failed,
      client({ kind: 'retry_scheduled' }),
    );
    const store = (await factory())();
    const started = store.capture(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(failed.query.mock.calls.map(([sql]) => sql)).toContain('rollback');
    expect(failed.connection.stream.destroy).toHaveBeenCalledOnce();
    expect(database.connect).toHaveBeenCalledTimes(2);
    failed.end();
    await expect(started).resolves.toEqual({ kind: 'retry_scheduled' });
    expect(database.connect).toHaveBeenCalledTimes(3);
    await store.close();
  });
  it('retains admission for an aborted pending checkout and releases its late client once', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<PoolClient>();
    database.connect.mockReturnValueOnce(pending.promise);
    const create = await factory();
    const store = create();
    const other = create();
    const started = store.capture(input);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(other.capture(input)).resolves.toEqual({ kind: 'busy' });
    const late = client(undefined);
    pending.resolve(late as unknown as PoolClient);
    await expect(started).resolves.toEqual({ kind: 'outcome_unknown' });
    expect(late.release).toHaveBeenCalledOnce();
    await store.close();
    await other.close();
  });
  it('aborts at the whole-attempt deadline and retains ownership until the raw query settles', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<unknown>();
    const capture = client(undefined, { command: () => pending.promise });
    queueClients(client({ kind: 'owned', fenceToken: '1' }), capture);
    const create = await factory();
    const store = create();
    const other = create();
    const started = store.capture(input);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(capture.connection.stream.destroy).toHaveBeenCalledOnce();
    await expect(other.capture(input)).resolves.toEqual({ kind: 'busy' });
    pending.reject(new Error('socket closed'));
    await expect(started).resolves.toEqual({ kind: 'outcome_unknown' });
    expect(database.connect).toHaveBeenCalledTimes(2);
    await store.close();
    await other.close();
  });
  it('fails readiness and refuses more writes when deadline disposal cannot be confirmed', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<unknown>();
    queueClients(
      client({ kind: 'owned', fenceToken: '1' }),
      client(undefined, { command: () => pending.promise }),
    );
    const store = (await factory())();
    const started = store.capture(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await started).toBeInstanceOf(Error);
    await expect(store.checkReadiness()).rejects.toThrow('unavailable');
    await expect(store.capture(input)).rejects.toThrow('unavailable');
    pending.reject(new Error('late socket close'));
    await store.whenIdle();
    await store.close();
  });
  it('close cancels owned work without claiming cancellation undid a commit', async () => {
    const pending = Promise.withResolvers<unknown>();
    const capture = client(undefined, { command: () => pending.promise });
    queueClients(client({ kind: 'owned', fenceToken: '1' }), capture);
    const store = (await factory())();
    const started = store.capture(input);
    await vi.waitFor(() => {
      expect(database.connect).toHaveBeenCalledTimes(2);
    });
    const closing = store.close();
    await vi.waitFor(() => {
      expect(capture.connection.stream.destroy).toHaveBeenCalledOnce();
    });
    expect(database.close).not.toHaveBeenCalled();
    pending.resolve({ kind: 'captured', audienceCount: '2' });
    await expect(started).resolves.toEqual({ kind: 'outcome_unknown' });
    await closing;
    expect(database.close).toHaveBeenCalledOnce();
    await expect(store.capture(input)).rejects.toThrow('unavailable');
  });
  it('stops new admission synchronously on close and does not poison a normally busy whenIdle', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<unknown>();
    queueClients(
      client({ kind: 'owned', fenceToken: '1' }),
      client(undefined, { command: () => pending.promise }),
    );
    const store = (await factory())();
    const started = store.capture(input);
    let idleDone = false;
    const idle = store.whenIdle().then(() => {
      idleDone = true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(idleDone).toBe(false);
    await store.checkReadiness();
    pending.resolve({ kind: 'captured', audienceCount: '1' });
    await started;
    await idle;
    const close = store.close();
    await expect(store.capture(input)).rejects.toThrow('unavailable');
    await close;
  });
  it('rejects incompatible transaction settings before any claim', async () => {
    const wrong = client(undefined);
    const usual = wrong.query.getMockImplementation();
    wrong.query.mockImplementation(async (text) =>
      text.includes('from pg_settings')
        ? {
            rows: [
              {
                workspace: workspaceId,
                lock_millis: '0',
                statement_millis: '0',
              },
            ],
          }
        : ((await usual?.(text)) ?? { rows: [] }),
    );
    queueClients(wrong);
    const store = (await factory())();
    await expect(store.capture(input)).rejects.toThrow('claim rejected');
    expect(
      wrong.query.mock.calls.some(([text]) => text.startsWith('select app.')),
    ).toBe(false);
    await store.close();
  });
});
