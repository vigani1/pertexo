import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDatabaseConfig } from '../src/config.js';
import type { WorkspaceInboxProjectionInput } from '../src/execution/workspace-inbox/projection-contract.js';

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
vi.mock('../src/execution/workspace-inbox/projection-readiness.js', () => ({
  checkInboxProjectionReadiness: database.readiness,
}));
const input: WorkspaceInboxProjectionInput = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workerId: 'projection-test',
  delivery: {
    outboxEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    payloadChecksum: 'a'.repeat(64),
  },
  signal: new AbortController().signal,
};
const config = parseDatabaseConfig({
  connectionString: 'postgresql://worker@fixture.invalid/disposable',
});
const projected = {
  kind: 'projected',
  processedCount: 100,
  insertedCount: 99,
  skippedCount: 1,
  hasMore: true,
} as const;
function client(
  result: unknown,
  options: Readonly<{
    command?: () => Promise<unknown>;
    commit?: () => Promise<void>;
    deferEnd?: boolean;
    mode?: 'capture' | 'projection';
  }> = {},
) {
  const statement = options.mode === 'capture' ? '5000' : '2000';
  const events = new EventEmitter();
  const end = () => events.emit('end');
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes('from pg_settings'))
      return {
        rows: [
          {
            workspace: input.workspaceId,
            lock_millis: '1000',
            statement_millis: statement,
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
      return { rows: [{ workspace: values[0] }] };
    return { rows: [{ workspace: null, actor: null, discovery: null }] };
  });
  return Object.assign(events, {
    query,
    end,
    release: vi.fn(),
    connection: {
      stream: {
        destroy: vi.fn(() => {
          if (!options.deferEnd) queueMicrotask(end);
        }),
      },
    },
  });
}
function queue(...clients: ReturnType<typeof client>[]) {
  for (const next of clients) database.connect.mockResolvedValueOnce(next);
}
async function stores() {
  const { createWorkspaceInboxCaptureStore } =
    await import('../src/execution/workspace-inbox/capture-store.js');
  const { createWorkspaceInboxProjectionStore } =
    await import('../src/execution/workspace-inbox/projection-store.js');
  return {
    capture: createWorkspaceInboxCaptureStore(config),
    projection: createWorkspaceInboxProjectionStore(config),
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  database.close.mockResolvedValue(undefined);
  database.readiness.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());
describe('inactive inbox projection ownership (mocked PostgreSQL)', () => {
  it.each(['capture', 'projection'] as const)(
    '%s close synchronously rejects new work and returns one memoized pool-close promise',
    async (owner) => {
      const poolClosed = Promise.withResolvers<undefined>();
      database.close.mockImplementationOnce(() => poolClosed.promise);
      const pair = await stores();
      const store = pair[owner];
      const closing = store.close();
      expect(store.close()).toBe(closing);
      await expect(store.checkReadiness()).rejects.toThrow('unavailable');
      await expect(
        owner === 'capture'
          ? pair.capture.capture(input)
          : pair.projection.projectNextPage(input),
      ).rejects.toThrow('unavailable');
      await vi.waitFor(() => {
        expect(database.close).toHaveBeenCalledOnce();
      });
      poolClosed.resolve(undefined);
      await closing;
      expect(store.close()).toBe(closing);
      expect(database.close).toHaveBeenCalledOnce();
      await (owner === 'capture' ? pair.projection : pair.capture).close();
      expect(database.close).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['capture', 'projection'] as const)(
    '%s rejects readiness that resolves after its lifetime closes',
    async (owner) => {
      const ready = Promise.withResolvers<undefined>();
      database.readiness.mockImplementationOnce(() => ready.promise);
      const pair = await stores();
      const checking = pair[owner].checkReadiness();
      expect(database.readiness).toHaveBeenCalledOnce();
      await pair[owner].close();
      ready.resolve(undefined);
      await expect(checking).rejects.toThrow('unavailable');
      await (owner === 'capture' ? pair.projection : pair.capture).close();
    },
  );
  it.each(['capture', 'projection'] as const)(
    'closing the idle peer does not cancel active %s work',
    async (owner) => {
      const pending = Promise.withResolvers<unknown>();
      const page = client(undefined, {
        mode: owner,
        command: () => pending.promise,
      });
      queue(client({ kind: 'owned', fenceToken: '1' }, { mode: owner }), page);
      const pair = await stores();
      const started =
        owner === 'capture'
          ? pair.capture.capture(input)
          : pair.projection.projectNextPage(input);
      await vi.waitFor(() => {
        expect(database.connect).toHaveBeenCalledTimes(2);
      });
      await (owner === 'capture' ? pair.projection : pair.capture).close();
      expect(page.connection.stream.destroy).not.toHaveBeenCalled();
      const result =
        owner === 'capture'
          ? { kind: 'captured', audienceCount: '1' }
          : projected;
      pending.resolve(result);
      await expect(started).resolves.toEqual(result);
      expect(page.connection.stream.destroy).not.toHaveBeenCalled();
      expect(page.release).toHaveBeenCalledOnce();
      await pair[owner].close();
    },
  );
  it.each(['capture', 'projection'] as const)(
    '%s whenIdle does not impose a settlement deadline on normally pending work',
    async (owner) => {
      vi.useFakeTimers();
      const pending = Promise.withResolvers<unknown>();
      queue(
        client({ kind: 'owned', fenceToken: '1' }, { mode: owner }),
        client(undefined, { mode: owner, command: () => pending.promise }),
      );
      const pair = await stores();
      const started =
        owner === 'capture'
          ? pair.capture.capture(input)
          : pair.projection.projectNextPage(input);
      let idleDone = false;
      const idle = pair[owner].whenIdle().then(() => {
        idleDone = true;
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(idleDone).toBe(false);
      await expect(pair[owner].checkReadiness()).resolves.toBeUndefined();
      await expect(
        owner === 'capture'
          ? pair.projection.projectNextPage(input)
          : pair.capture.capture(input),
      ).resolves.toEqual({ kind: 'busy' });
      const result =
        owner === 'capture'
          ? { kind: 'captured', audienceCount: '1' }
          : projected;
      pending.resolve(result);
      await expect(started).resolves.toEqual(result);
      await idle;
      expect(idleDone).toBe(true);
      await expect(pair[owner].checkReadiness()).resolves.toBeUndefined();
      await pair.capture.close();
      await pair.projection.close();
    },
  );
  it('owns a separately committed claim and bounded page with exact fence and original delivery', async () => {
    const claim = client({ kind: 'owned', fenceToken: '9007199254740993' }),
      page = client(projected);
    queue(claim, page);
    const { projection } = await stores();
    await expect(projection.projectNextPage(input)).resolves.toEqual(projected);
    expect(claim.query).toHaveBeenCalledWith(
      'select app.claim_workspace_inbox_projection($1,$2,$3,$4,$5,$6) result',
      [
        input.workspaceId,
        input.sourceId,
        input.delivery.outboxEventId,
        input.delivery.payloadChecksum,
        input.workerId,
        expect.any(String),
      ],
    );
    const lease = claim.query.mock.calls.find(([text]) =>
      text.startsWith('select app.'),
    )?.[1]?.[5];
    expect(page.query).toHaveBeenCalledWith(
      'select app.project_workspace_inbox_page($1,$2,$3,$4) result',
      [input.workspaceId, input.sourceId, lease, '9007199254740993'],
    );
    for (const connection of [claim, page]) {
      expect(connection.query.mock.calls.map(([text]) => text)).toContain(
        'commit',
      );
      expect(
        connection.query.mock.calls.find(([text]) =>
          text.includes("set_config('statement_timeout'"),
        )?.[1],
      ).toEqual([input.workspaceId, '2000ms']);
      expect(connection.release).toHaveBeenCalledOnce();
    }
    await projection.close();
  });
  it.each([
    'completed',
    'not_captured',
    'blocked',
    'expired',
    'inactive',
    'unavailable',
    'busy',
    'not_due',
    'lost_ownership',
    'retry_scheduled',
  ] as const)('does not run a page after %s', async (kind) => {
    queue(client({ kind }));
    const { projection } = await stores();
    await expect(projection.projectNextPage(input)).resolves.toEqual({ kind });
    expect(database.connect).toHaveBeenCalledOnce();
    await projection.close();
  });
  it('accounts only an acknowledged page rollback after observed connection end', async () => {
    const failed = client(undefined, {
      command: () => Promise.reject(new Error('statement timeout')),
      deferEnd: true,
    });
    queue(
      client({ kind: 'owned', fenceToken: '2' }),
      failed,
      client({ kind: 'retry_scheduled' }),
    );
    const { projection, capture } = await stores();
    const started = projection.projectNextPage(input);
    await vi.waitFor(() => {
      expect(failed.query.mock.calls.map(([text]) => text)).toContain(
        'rollback',
      );
    });
    await expect(capture.capture(input)).resolves.toEqual({ kind: 'busy' });
    expect(database.connect).toHaveBeenCalledTimes(2);
    failed.end();
    await expect(started).resolves.toEqual({ kind: 'retry_scheduled' });
    expect(database.connect).toHaveBeenCalledTimes(3);
    await projection.close();
    await capture.close();
  });
  it.each(['claim', 'page'] as const)(
    'does not account or replay after an uncertain %s commit',
    async (phase) => {
      const failed = client(
        phase === 'claim' ? { kind: 'owned', fenceToken: '1' } : projected,
        { commit: () => Promise.reject(new Error('lost acknowledgment')) },
      );
      if (phase === 'page') queue(client({ kind: 'owned', fenceToken: '1' }));
      queue(failed);
      const { projection } = await stores();
      await expect(projection.projectNextPage(input)).resolves.toEqual({
        kind: 'outcome_unknown',
      });
      expect(database.connect).toHaveBeenCalledTimes(phase === 'claim' ? 1 : 2);
      expect(failed.query.mock.calls.map(([text]) => text)).not.toContain(
        'rollback',
      );
      await projection.close();
    },
  );
  it.each(['capture', 'projection'] as const)(
    '%s admission excludes the other store, including different sources',
    async (owner) => {
      const pending = Promise.withResolvers<PoolClient>();
      database.connect.mockReturnValueOnce(pending.promise);
      const pair = await stores(),
        controller = new AbortController();
      const started =
        owner === 'capture'
          ? pair.capture.capture({ ...input, signal: controller.signal })
          : pair.projection.projectNextPage({
              ...input,
              signal: controller.signal,
            });
      const otherInput = {
        ...input,
        sourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      };
      await expect(
        owner === 'capture'
          ? pair.projection.projectNextPage(otherInput)
          : pair.capture.capture(otherInput),
      ).resolves.toEqual({ kind: 'busy' });
      controller.abort();
      const late = client(undefined);
      pending.resolve(late as unknown as PoolClient);
      await expect(started).resolves.toEqual({ kind: 'outcome_unknown' });
      expect(late.release).toHaveBeenCalledOnce();
      queue(client({ kind: 'completed' }));
      await expect(
        pair.projection.projectNextPage(otherInput),
      ).resolves.toEqual({ kind: 'completed' });
      await pair.capture.close();
      await pair.projection.close();
    },
  );
  it.each(['capture', 'projection'] as const)(
    'retains %s admission after query rejection until driver end',
    async (owner) => {
      const mode = owner,
        failed = client(
          owner === 'capture' ? { kind: 'owned', fenceToken: '1' } : projected,
          {
            mode,
            commit: () => Promise.reject(new Error('lost commit')),
            deferEnd: true,
          },
        );
      if (owner === 'projection')
        queue(client({ kind: 'owned', fenceToken: '1' }));
      queue(failed);
      const pair = await stores();
      const started =
        owner === 'capture'
          ? pair.capture.capture(input)
          : pair.projection.projectNextPage(input);
      await vi.waitFor(() => {
        expect(failed.connection.stream.destroy).toHaveBeenCalledOnce();
      });
      await expect(
        owner === 'capture'
          ? pair.projection.projectNextPage(input)
          : pair.capture.capture(input),
      ).resolves.toEqual({ kind: 'busy' });
      failed.end();
      await expect(started).resolves.toEqual({ kind: 'outcome_unknown' });
      await pair.capture.close();
      await pair.projection.close();
    },
  );
  it('quarantines both stores on unconfirmed disposal, even after late end', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<unknown>();
    const failed = client(undefined, {
      command: () => pending.promise,
      deferEnd: true,
    });
    queue(client({ kind: 'owned', fenceToken: '1' }), failed);
    const pair = await stores();
    const started = pair.projection
      .projectNextPage(input)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await started).toBeInstanceOf(Error);
    for (const store of [pair.capture, pair.projection])
      await expect(store.checkReadiness()).rejects.toThrow('unavailable');
    await expect(pair.capture.capture(input)).rejects.toThrow('unavailable');
    await expect(pair.projection.projectNextPage(input)).rejects.toThrow(
      'unavailable',
    );
    pending.reject(new Error('late wire failure'));
    failed.end();
    await pair.projection.whenIdle();
    await expect(pair.capture.capture(input)).rejects.toThrow('unavailable');
    await pair.capture.close();
    await pair.projection.close();
  });
  it('close aborts only its own work, preserves shared admission until settlement, and never claims rollback', async () => {
    const pending = Promise.withResolvers<unknown>(),
      failed = client(undefined, { command: () => pending.promise });
    queue(client({ kind: 'owned', fenceToken: '1' }), failed);
    const pair = await stores(),
      started = pair.projection.projectNextPage(input);
    await vi.waitFor(() => {
      expect(database.connect).toHaveBeenCalledTimes(2);
    });
    const closing = pair.projection.close();
    await expect(pair.capture.capture(input)).resolves.toEqual({
      kind: 'busy',
    });
    pending.resolve(projected);
    await expect(started).resolves.toEqual({ kind: 'outcome_unknown' });
    await closing;
    expect(failed.query.mock.calls.map(([text]) => text)).not.toContain(
      'rollback',
    );
    await expect(pair.projection.projectNextPage(input)).rejects.toThrow(
      'unavailable',
    );
    await pair.capture.close();
  });
  it('validates page counts before commit and owns failure accounting after rollback', async () => {
    queue(
      client({ kind: 'owned', fenceToken: '1' }),
      client({ ...projected, processedCount: 1 }),
      client({ kind: 'retry_scheduled' }),
    );
    const { projection } = await stores();
    await expect(projection.projectNextPage(input)).resolves.toEqual({
      kind: 'retry_scheduled',
    });
    expect(database.connect).toHaveBeenCalledTimes(3);
    await projection.close();
  });
});
