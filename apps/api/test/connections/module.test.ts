import { describe, expect, it } from 'vitest';

import {
  ConnectionsController,
  ConnectionsModule,
  CreateConnectionUseCase,
  GetConnectionUseCase,
  ListConnectionsUseCase,
  LookupSlackChannelsUseCase,
  FailureNotificationDestinationsController,
  FailureNotificationDestinationUseCases,
  type ConnectionDependencies,
} from '../../src/connections/index.js';
import { CONNECTION_AUTHORIZATION } from '../../src/connections/tokens.js';

const dependencies = {
  persistence: {
    createConnection: () => Promise.reject(new Error('not exercised')),
    listConnections: () => Promise.resolve({ items: [] }),
    readConnection: () => Promise.resolve(null),
    findConnectionCreateReplay: () => Promise.resolve(null),
    findConnectionRotateReplay: () => Promise.resolve(null),
    rotateConnectionSecret: () => Promise.reject(new Error('not exercised')),
    revokeConnection: () => Promise.reject(new Error('not exercised')),
    startConnectionTest: () => Promise.reject(new Error('not exercised')),
    resolveConnectionTestSecret: () =>
      Promise.reject(new Error('not exercised')),
    markConnectionTestDispatched: () =>
      Promise.reject(new Error('not exercised')),
    completeConnectionTest: () => Promise.reject(new Error('not exercised')),
    abandonConnectionTest: () => Promise.reject(new Error('not exercised')),
    resolveConnectionLookupSecret: () =>
      Promise.reject(new Error('not exercised')),
  },
  authorization: { findAccess: () => Promise.resolve(undefined) },
  encryption: {
    seal: () => Promise.reject(new Error('not exercised')),
    open: () => Promise.reject(new Error('not exercised')),
  },
  httpClient: { execute: () => Promise.reject(new Error('not exercised')) },
  destinationPersistence: {
    create: () => Promise.reject(new Error('not exercised')),
    get: () => Promise.reject(new Error('not exercised')),
    list: () => Promise.reject(new Error('not exercised')),
    appendVersion: () => Promise.reject(new Error('not exercised')),
    setStatus: () => Promise.reject(new Error('not exercised')),
    setWorkflowPolicy: () => Promise.reject(new Error('not exercised')),
    clearWorkflowPolicy: () => Promise.reject(new Error('not exercised')),
    getWorkflowPolicy: () => Promise.reject(new Error('not exercised')),
    close: () => Promise.resolve(),
  },
} satisfies ConnectionDependencies;

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}

describe('connections Nest module', () => {
  it('registers explicit application providers and the controller', () => {
    const dynamic = ConnectionsModule.register(dependencies, {
      module: FakeIdentityModule,
    });
    expect(dynamic.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: CreateConnectionUseCase }),
        expect.objectContaining({ provide: ListConnectionsUseCase }),
        expect.objectContaining({ provide: GetConnectionUseCase }),
        expect.objectContaining({ provide: LookupSlackChannelsUseCase }),
        expect.objectContaining({
          provide: FailureNotificationDestinationUseCases,
        }),
      ]),
    );
    expect(dynamic.controllers).toContain(ConnectionsController);
    expect(dynamic.controllers).toContain(
      FailureNotificationDestinationsController,
    );
    expect(dynamic.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: CONNECTION_AUTHORIZATION }),
      ]),
    );
  });

  it('omits only destination routes and providers when destination persistence is absent', () => {
    const dynamic = ConnectionsModule.register(
      {
        persistence: dependencies.persistence,
        authorization: dependencies.authorization,
        encryption: dependencies.encryption,
        httpClient: dependencies.httpClient,
      },
      { module: FakeIdentityModule },
    );

    expect(dynamic.controllers).toContain(ConnectionsController);
    expect(dynamic.controllers).not.toContain(
      FailureNotificationDestinationsController,
    );
    expect(dynamic.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: CreateConnectionUseCase }),
        expect.objectContaining({ provide: CONNECTION_AUTHORIZATION }),
      ]),
    );
    expect(dynamic.providers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provide: FailureNotificationDestinationUseCases,
        }),
      ]),
    );
  });
});
