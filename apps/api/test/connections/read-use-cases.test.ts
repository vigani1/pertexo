import type { ConnectionReadPersistence } from '../../src/connections/ports.js';
import {
  GetConnectionUseCase,
  ListConnectionsUseCase,
} from '../../src/connections/use-cases.js';
import { describe, expect, it, vi } from 'vitest';
import {
  actor,
  authorization,
  connectionId,
  record,
  secretVersionId,
  workspaceId,
} from './support/use-case-fixture.js';

function readPersistence(overrides: Partial<ConnectionReadPersistence> = {}) {
  return {
    listConnections: vi.fn<ConnectionReadPersistence['listConnections']>(() =>
      Promise.resolve({ items: [record()] }),
    ),
    readConnection: vi.fn<ConnectionReadPersistence['readConnection']>(() =>
      Promise.resolve(record()),
    ),
    ...overrides,
  } satisfies ConnectionReadPersistence;
}

describe('connection read use cases', () => {
  it('authorizes, serializes safe metadata, and round-trips an opaque cursor', async () => {
    const persistence = readPersistence({
      listConnections: vi
        .fn<ConnectionReadPersistence['listConnections']>()
        .mockResolvedValueOnce({
          items: [record()],
          nextCursor: {
            status: 'active',
            createdAt: '2026-08-22T12:00:00.000123Z',
            id: connectionId,
          },
        })
        .mockResolvedValueOnce({ items: [] }),
    });
    const access = authorization();
    const useCase = new ListConnectionsUseCase(persistence, access);

    const first = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      limit: 1,
    });
    expect(first.items[0]).toMatchObject({
      id: connectionId,
      name: 'Operations API',
      secretVersionId,
    });
    expect(first.items[0]).not.toHaveProperty('credential');
    expect(first.nextCursor).toEqual(expect.any(String));

    if (first.nextCursor === null) throw new Error('expected a next cursor');
    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      after: first.nextCursor,
    });
    expect(persistence.listConnections).toHaveBeenLastCalledWith({
      workspaceId,
      actorId: actor.actorId,
      after: {
        status: 'active',
        createdAt: '2026-08-22T12:00:00.000123Z',
        id: connectionId,
      },
    });
    expect(access.findAccess).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid cursor before reading persistence', async () => {
    const persistence = readPersistence();
    const useCase = new ListConnectionsUseCase(persistence, authorization());
    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        after: 'invalid',
      }),
    ).rejects.toThrow('connection cursor is invalid');
    expect(persistence.listConnections).not.toHaveBeenCalled();
  });

  it('returns one visible connection and preserves not-found privacy', async () => {
    const readConnection = vi.fn<ConnectionReadPersistence['readConnection']>(
      () => Promise.resolve(record()),
    );
    const persistence = readPersistence({ readConnection });
    const useCase = new GetConnectionUseCase(persistence, authorization());
    await expect(
      useCase.execute({ actor, routeWorkspaceId: workspaceId, connectionId }),
    ).resolves.toMatchObject({ id: connectionId, workspaceId });

    readConnection.mockResolvedValueOnce(null);
    await expect(
      useCase.execute({ actor, routeWorkspaceId: workspaceId, connectionId }),
    ).rejects.toThrow('Connection is not visible');
  });
});
