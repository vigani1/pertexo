import { describe, expect, it } from 'vitest';

import {
  ConnectionsController,
  ConnectionsModule,
  CreateConnectionUseCase,
  type ConnectionDependencies,
} from '../../src/connections/index.js';

const dependencies = {
  persistence: {
    createConnection: () => Promise.reject(new Error('not exercised')),
    findConnectionCreateReplay: () => Promise.resolve(null),
    findConnectionRotateReplay: () => Promise.resolve(null),
    rotateConnectionSecret: () => Promise.reject(new Error('not exercised')),
    revokeConnection: () => Promise.reject(new Error('not exercised')),
  },
  authorization: { findAccess: () => Promise.resolve(undefined) },
  encryption: { seal: () => Promise.reject(new Error('not exercised')) },
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
      ]),
    );
    expect(dynamic.controllers).toContain(ConnectionsController);
  });
});
