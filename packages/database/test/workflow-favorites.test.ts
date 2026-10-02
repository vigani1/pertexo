import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowFavoriteDatabase,
  WorkflowFavoriteRevisionConflictError,
  WorkflowOrganizationUnavailableError,
  WorkflowOrganizationValidationError,
  type WorkflowFavoriteAbsenceTokenAuthority,
} from '../src/authoring/workflow-favorites.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from '../src/authoring/workflow-authoring-errors.js';
import { parseDatabaseConfig } from '../src/config.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn<(sql: string, args?: unknown[]) => Promise<unknown>>(),
  transact: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../src/platform/database-runtime.js', () => ({
  acquireDatabasePool: () => ({ pool: {}, close: mocks.close }),
}));
vi.mock('../src/tenant-access/workspace.js', () => ({
  withTenantScopedClient: mocks.transact,
}));
const scope = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const generation = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const revision = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const token = `absent.v1.100.86500.${'A'.repeat(43)}`;
const proof = { generation, issuedAtSeconds: 100, expiresAtSeconds: 86500 };
const state = { isFavorite: false, favoriteRevision: revision };
const result = { ...state, replayed: false };
const config = parseDatabaseConfig({
  connectionString: 'postgresql://pertexo_api:synthetic@127.0.0.1:5432/test',
});
function fixture() {
  const authority: WorkflowFavoriteAbsenceTokenAuthority = {
    issue: vi.fn().mockReturnValue(token),
    verify: vi.fn().mockReturnValue(proof),
  };
  const store = createWorkflowFavoriteDatabase(config, {
    absenceTokens: authority,
  });
  return { authority, store };
}
const command = {
  ...scope,
  favorite: false,
  expectedFavoriteRevision: token,
  idempotencyKey: 'favorite-request',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  mocks.transact.mockImplementation(
    (_pool: unknown, _scope: unknown, work: (client: PoolClient) => unknown) =>
      Promise.resolve(work({ query: mocks.query } as unknown as PoolClient)),
  );
});

describe('favorite adapter private transaction protocol', () => {
  it('issues absence from the database snapshot without exposing generation or clock', async () => {
    const { authority, store } = fixture();
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ snapshot: { generation, readAtSeconds: 100 } }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    expect(await store.readFavorite(scope)).toEqual({
      isFavorite: false,
      favoriteRevision: token,
    });
    expect(authority.issue).toHaveBeenCalledWith(scope, {
      generation,
      issuedAtSeconds: 100,
    });
    expect(mocks.transact).toHaveBeenCalledTimes(1);
  });

  it('reads current opaque revision without issuing an absence token', async () => {
    const { authority, store } = fixture();
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ snapshot: { generation, readAtSeconds: 100 } }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ favorite: false, revision }] });
    expect(await store.readFavorite(scope)).toEqual(state);
    expect(authority.issue).not.toHaveBeenCalled();
  });

  it('denies invisible workflows before private state lookup or token issuance', async () => {
    const { authority, store } = fixture();
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ snapshot: { generation, readAtSeconds: 100 } }],
      })
      .mockResolvedValueOnce({ rowCount: 0 });
    await expect(store.readFavorite(scope)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(authority.issue).not.toHaveBeenCalled();
  });

  it('rejects malformed trusted issuer output instead of projecting it', async () => {
    const { authority, store } = fixture();
    vi.mocked(authority.issue).mockReturnValue('absent');
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ snapshot: { generation, readAtSeconds: 100 } }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    await expect(store.readFavorite(scope)).rejects.toThrow();
  });

  it('prepares before MAC verification and writes the verified proof in the same transaction', async () => {
    const { authority, store } = fixture();
    mocks.query
      .mockResolvedValueOnce({ rows: [{ claim: { kind: 'new', generation } }] })
      .mockResolvedValueOnce({ rows: [{ result }] });
    expect(await store.setFavorite(command)).toEqual(result);
    expect(authority.verify).toHaveBeenCalledWith(token, scope, generation);
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(authority.verify).mock.invocationCallOrder[0] ?? -Infinity,
    );
    expect(
      vi.mocked(authority.verify).mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.query.mock.invocationCallOrder[1] ?? -Infinity);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      scope.workflowId,
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      JSON.stringify({ favorite: false, expectedFavoriteRevision: token }),
      generation,
      100,
      86500,
    ]);
    expect(mocks.transact).toHaveBeenCalledTimes(1);
  });

  it('returns exact committed recovery without invoking MAC verification', async () => {
    const { authority, store } = fixture();
    vi.mocked(authority.verify).mockImplementation(() => {
      throw new Error('rotated authority');
    });
    mocks.query.mockResolvedValueOnce({
      rows: [
        { claim: { kind: 'replay', result: { ...result, replayed: true } } },
      ],
    });
    expect(await store.setFavorite(command)).toEqual({
      ...result,
      replayed: true,
    });
    expect(authority.verify).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad MAC without reaching the write helper', async () => {
    const { authority, store } = fixture();
    vi.mocked(authority.verify).mockReturnValue(null);
    mocks.query.mockResolvedValueOnce({
      rows: [{ claim: { kind: 'new', generation } }],
    });
    await expect(store.setFavorite(command)).rejects.toBeInstanceOf(
      WorkflowFavoriteRevisionConflictError,
    );
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('does not swallow unexpected verifier failures', async () => {
    const { authority, store } = fixture();
    const failure = new Error('operational verifier failure');
    vi.mocked(authority.verify).mockImplementation(() => {
      throw failure;
    });
    mocks.query.mockResolvedValueOnce({
      rows: [{ claim: { kind: 'new', generation } }],
    });
    await expect(store.setFavorite(command)).rejects.toBe(failure);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('rejects proof from a different generation without reaching SQL write', async () => {
    const { authority, store } = fixture();
    vi.mocked(authority.verify).mockReturnValue({
      ...proof,
      generation: revision,
    });
    mocks.query.mockResolvedValueOnce({
      rows: [{ claim: { kind: 'new', generation } }],
    });
    await expect(store.setFavorite(command)).rejects.toBeInstanceOf(
      WorkflowFavoriteRevisionConflictError,
    );
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('never verifies a present-state UUID and supplies no absence proof', async () => {
    const { authority, store } = fixture();
    mocks.query
      .mockResolvedValueOnce({ rows: [{ claim: { kind: 'new', generation } }] })
      .mockResolvedValueOnce({ rows: [{ result }] });
    await store.setFavorite({ ...command, expectedFavoriteRevision: revision });
    expect(authority.verify).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[1]?.[1]?.slice(-3)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it.each([
    ['42501', WorkflowNotFoundError],
    ['P7001', WorkflowOrganizationUnavailableError],
    ['P7002', WorkflowIdempotencyConflictError],
    ['P7010', WorkflowFavoriteRevisionConflictError],
    ['22023', WorkflowOrganizationValidationError],
  ])(
    'maps %s to a generic boundary error before MAC verification',
    async (code, errorType) => {
      const { authority, store } = fixture();
      mocks.query.mockRejectedValueOnce({
        code,
        detail: 'private state must not escape',
      });
      await expect(store.setFavorite(command)).rejects.toBeInstanceOf(
        errorType,
      );
      expect(authority.verify).not.toHaveBeenCalled();
    },
  );

  it('forwards cancellation and delegates lifecycle ownership to its pool lease', async () => {
    const { store } = fixture();
    const signal = new AbortController().signal;
    mocks.query.mockResolvedValueOnce({
      rows: [
        { claim: { kind: 'replay', result: { ...result, replayed: true } } },
      ],
    });
    await store.setFavorite({ ...command, signal });
    expect(mocks.transact.mock.calls[0]?.[3]).toEqual({ signal });
    await store.close();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
